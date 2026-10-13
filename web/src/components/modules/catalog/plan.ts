import type { CatalogModelItem } from '@/api/catalog';
import type { Setting } from '@/api/setting';
import { MAX_MATCH_PATTERN_LENGTH } from '@/components/modules/group/utils';

// 模型库规则在设置里的键, 与 internal/model/setting.go 的常量一一对应。
export const CATALOG_KEYS = {
    enabled: 'catalog_filter_enabled',
    releaseDays: 'catalog_release_days',
    requireToolCall: 'catalog_require_tool_call',
    minContext: 'catalog_min_context',
    dropDeprecated: 'catalog_drop_deprecated',
    unknownPolicy: 'catalog_unknown_policy',
} as const;

// CatalogRules 是页面上的规则草稿, 保存后由后端在渠道同步时执行。
export interface CatalogRules {
    enabled: boolean;
    releaseDays: number;
    requireToolCall: boolean;
    minContext: number;
    dropDeprecated: boolean;
    unknownPolicy: 'keep' | 'drop';
}

// 默认值与后端的 DefaultSettings 保持一致: 规则关闭, 只有「排除已弃用」默认打开。
export const DEFAULT_RULES: CatalogRules = {
    enabled: false,
    releaseDays: 0,
    requireToolCall: false,
    minContext: 0,
    dropDeprecated: true,
    unknownPolicy: 'keep',
};

// RELEASE_DAYS_STOPS 是时间轴上的刻度, 0 表示不限时间。
export const RELEASE_DAYS_STOPS = [7, 30, 90, 180, 365, 0] as const;

// settingsToRules 把设置列表还原成规则草稿, 缺失或非法的项退回默认值。
export function settingsToRules(settings: Setting[]): CatalogRules {
    const map = new Map(settings.map((setting) => [setting.key, setting.value]));
    const bool = (key: string, fallback: boolean) => {
        const value = map.get(key);
        if (value === 'true') return true;
        if (value === 'false') return false;
        return fallback;
    };
    const number = (key: string, fallback: number) => {
        const value = Number.parseInt(map.get(key) ?? '', 10);
        return Number.isFinite(value) && value >= 0 ? value : fallback;
    };
    return {
        enabled: bool(CATALOG_KEYS.enabled, DEFAULT_RULES.enabled),
        releaseDays: number(CATALOG_KEYS.releaseDays, DEFAULT_RULES.releaseDays),
        requireToolCall: bool(CATALOG_KEYS.requireToolCall, DEFAULT_RULES.requireToolCall),
        minContext: number(CATALOG_KEYS.minContext, DEFAULT_RULES.minContext),
        dropDeprecated: bool(CATALOG_KEYS.dropDeprecated, DEFAULT_RULES.dropDeprecated),
        unknownPolicy: map.get(CATALOG_KEYS.unknownPolicy) === 'drop' ? 'drop' : 'keep',
    };
}

// rulesToSettings 把规则草稿转成一条条设置, 顺序固定便于失败时定位。
export function rulesToSettings(rules: CatalogRules): Setting[] {
    return [
        { key: CATALOG_KEYS.enabled, value: rules.enabled ? 'true' : 'false' },
        { key: CATALOG_KEYS.releaseDays, value: String(rules.releaseDays) },
        { key: CATALOG_KEYS.requireToolCall, value: rules.requireToolCall ? 'true' : 'false' },
        { key: CATALOG_KEYS.minContext, value: String(rules.minContext) },
        { key: CATALOG_KEYS.dropDeprecated, value: rules.dropDeprecated ? 'true' : 'false' },
        { key: CATALOG_KEYS.unknownPolicy, value: rules.unknownPolicy },
    ];
}

export function rulesEqual(left: CatalogRules, right: CatalogRules): boolean {
    return (
        left.enabled === right.enabled &&
        left.releaseDays === right.releaseDays &&
        left.requireToolCall === right.requireToolCall &&
        left.minContext === right.minContext &&
        left.dropDeprecated === right.dropDeprecated &&
        left.unknownPolicy === right.unknownPolicy
    );
}

// keepLocally 是与后端 CatalogFilter 同口径的本地预判, 让未保存的规则也能立刻看到结果。
// 两个守卫的顺序和后端一致: 总开关(以及空目录)先说保留, 再谈未收录模型怎么办,
// 否则关掉规则却设了「未收录即丢弃」时, 页面会显示成删除而同步其实什么都没删。
// releasedAt 传发布日期的时间戳可以省掉逐行 Date.parse; catalogEmpty 传目录为空的事实。
export function keepLocally(
    item: CatalogModelItem,
    rules: CatalogRules,
    context: { releasedAt?: number; catalogEmpty?: boolean } = {},
): { kept: boolean; reason: string } {
    if (!rules.enabled || context.catalogEmpty) return { kept: true, reason: '' };
    if (!item.matched) {
        return rules.unknownPolicy === 'drop' ? { kept: false, reason: 'unknown' } : { kept: true, reason: '' };
    }
    if (rules.dropDeprecated && item.status === 'deprecated') return { kept: false, reason: 'deprecated' };
    if (rules.requireToolCall && !item.tool_call) return { kept: false, reason: 'tool_call' };
    if (rules.minContext > 0 && item.context_window > 0 && item.context_window < rules.minContext) {
        return { kept: false, reason: 'context' };
    }
    if (rules.releaseDays > 0) {
        const released = context.releasedAt ?? parseReleaseDate(item.release_date);
        if (released !== undefined && released < Date.now() - rules.releaseDays * 24 * 60 * 60 * 1000) {
            return { kept: false, reason: 'release' };
        }
    }
    return { kept: true, reason: '' };
}

// parseReleaseDate 把目录里的 YYYY-MM-DD 转成时间戳, 空值或非法值返回 undefined。
export function parseReleaseDate(releaseDate: string): number | undefined {
    if (!releaseDate) return undefined;
    const parsed = Date.parse(`${releaseDate}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed : undefined;
}

// VARIANT_TAIL 是「同一个模型的另一种写法」的尾巴: 日期副本与思考/预览这类标记。
// SEPARATOR_GUARD 用它收住每一条候选: gpt-4 不该吃掉 gpt-4o, gpt-4o 也不该吃掉 gpt-4o-mini,
// 而 gpt-4o-2024-11-20、claude-sonnet-4-5-thinking 这类同型号写法要继续覆盖到。
const VARIANT_TAIL = String.raw`(?:[-@:]\d{4}-?\d{2}-?\d{2}|[-@:]\d{6,8}|@[a-z0-9]{2,}|[-:](?:thinking|think|reasoning|latest|preview|experimental|exp|chat-latest|high|medium|low|free|nitro))`;
const SEPARATOR_GUARD = `(?:$|${VARIANT_TAIL}(?:$|[-@.:_/]))`;

// groupPattern 用一行模型在渠道里的全部原始写法构造匹配表达式。
// 必须带上原始名字: 分组成员匹配的是渠道里的模型名, 而 model_id 是归一化后的身份名,
// 带供应商前缀(openai/gpt-4o)或日期后缀(-20250929)的写法只有原始名字才匹得上。
// 生成的正则要交给后端的 ECMAScript 校验, 故长度控制在 MAX_MATCH_PATTERN_LENGTH 之内, 超长的候选按从长到短丢弃。
export function groupPattern(rawNames: string[], identity: string): string {
    const names = Array.from(new Set([identity, ...rawNames].map((name) => name.trim()).filter(Boolean)));
    names.sort((left, right) => right.length - left.length);
    const alternatives: string[] = [];
    let budget = MAX_MATCH_PATTERN_LENGTH - '^(?:)'.length - SEPARATOR_GUARD.length;
    for (const name of names) {
        const escaped = escapeLiteral(name);
        if (alternatives.length > 0 && escaped.length + 1 > budget) continue;
        alternatives.push(escaped);
        budget -= escaped.length + 1;
    }
    return `^(?:${alternatives.join('|')})${SEPARATOR_GUARD}`;
}

function escapeLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// groupPlan 算出需要为哪些模型新建分组, 已存在的分组交给「更新分组」补成员。
export function groupPlan(modelNames: string[], existingNames: string[]): { create: string[]; existing: string[] } {
    const existing = new Set(existingNames);
    const create: string[] = [];
    const reuse: string[] = [];
    const seen = new Set<string>();
    for (const name of modelNames) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (existing.has(name)) {
            reuse.push(name);
        } else {
            create.push(name);
        }
    }
    return { create, existing: reuse };
}

import { useDeferredValue, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { toast } from 'sonner';
import { CalendarClock, ChevronDown, Sparkles } from 'lucide-react';
import { apiRequest, errorMessage } from '@/api/client';
import { catalogModelsQueryOptions, useCatalogModels } from '@/api/catalog';
import type { Group } from '@/api/group';
import { groupListQueryOptions } from '@/api/queries';
import { useSettingList } from '@/api/setting';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ListState } from '@/components/common/ListState';
import { SyncAll } from '@/components/modules/channel/SyncAll';
import { syncGroupsAfterChannelSync } from '@/components/modules/group/sync';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
    RELEASE_DAYS_STOPS,
    groupPattern,
    groupPlan,
    keepLocally,
    parseReleaseDate,
    rulesEqual,
    rulesToSettings,
    settingsToRules,
    type CatalogRules,
} from './plan';

// formatContext 把上下文窗口压成 128K / 1M 这样的短写法。
function formatContext(value: number): string {
    if (value <= 0) return '—';
    if (value >= 1_000_000) {
        const millions = value / 1_000_000;
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
    }
    if (value >= 1000) return `${Math.round(value / 1000)}K`;
    return String(value);
}

// formatUpdatedAt 把目录更新时间(Unix 秒)转成本地时间, 0 表示还没拉过目录。
function formatUpdatedAt(seconds: number): string {
    if (!seconds) return '';
    return new Date(seconds * 1000).toLocaleString();
}

// GroupOutcome 是「生成分组」里一个模型的结果, members 是该分组本轮新增的成员数。
type GroupOutcome = { name: string; status: 'created' | 'reused' | 'failed'; members: number; error?: string };

// Catalog 是模型库页面: 左侧规则, 右侧按研发商分组的渠道模型清单。
export function Catalog() {
    const t = useTranslations('catalog');
    const queryClient = useQueryClient();
    const { data, isPending, isError, error, refetch } = useCatalogModels();
    const settingsQuery = useSettingList();
    const settings = settingsQuery.data;
    // 设置列表到位之前不渲染真实规则, 否则用户会把默认值当成已保存的配置再存回去。
    const settingsReady = settings !== undefined;

    const [draft, setDraft] = useState<CatalogRules | null>(null);
    const [selectionMode, setSelectionMode] = useState<'all' | 'manual'>('all');
    const [manualSelection, setManualSelection] = useState<Set<string>>(new Set());
    const [confirmGroups, setConfirmGroups] = useState(false);
    const [rulesOpen, setRulesOpen] = useState(false);
    const [report, setReport] = useState<GroupOutcome[] | null>(null);

    const savedRules = useMemo(() => settingsToRules(settings ?? []), [settings]);
    const rules = draft ?? savedRules;
    const dirty = !rulesEqual(rules, savedRules);
    // 拖时间轴会连续改规则, 列表判定用延迟值, 输入控件本身保持即时响应。
    const deferredRules = useDeferredValue(rules);

    const summary = data?.summary;
    const updatedAt = summary ? formatUpdatedAt(summary.updated_at) : '';

    const rows = useMemo(
        () =>
            (data?.items ?? []).map((item) => ({
                item,
                verdict: keepLocally(item, deferredRules, {
                    releasedAt: parseReleaseDate(item.release_date),
                    catalogEmpty: summary === undefined || summary.catalog_count === 0,
                }),
            })),
        [data, deferredRules, summary],
    );
    const keptRows = useMemo(() => rows.filter((row) => row.verdict.kept), [rows]);
    const keptNames = useMemo(() => keptRows.map((row) => row.item.model_id), [keptRows]);

    // 勾选状态按「全选 / 手动」两种模式推导, 规则一变就跟着收敛, 不会留下已丢弃模型的陈旧快照。
    const selectedNames = useMemo(() => {
        if (selectionMode === 'all') return new Set(keptNames);
        const kept = new Set(keptNames);
        return new Set(Array.from(manualSelection).filter((name) => kept.has(name)));
    }, [selectionMode, keptNames, manualSelection]);
    const allSelected = keptNames.length > 0 && keptNames.every((name) => selectedNames.has(name));

    const groups = useMemo(() => {
        const map = new Map<string, typeof rows>();
        for (const row of rows) {
            const developer = row.item.developer || '';
            const bucket = map.get(developer);
            if (bucket) {
                bucket.push(row);
            } else {
                map.set(developer, [row]);
            }
        }
        // 未识别的研发商排在最后: 它们是兜底桶, 不该挡在具体厂商前面。
        const entries = Array.from(map.entries());
        entries.sort((left, right) => Number(left[0] === '') - Number(right[0] === ''));
        return entries;
    }, [rows]);

    const toggleSelected = (modelID: string) => {
        const next = new Set(selectedNames);
        if (next.has(modelID)) {
            next.delete(modelID);
        } else {
            next.add(modelID);
        }
        setManualSelection(next);
        setSelectionMode('manual');
    };

    const toggleAll = () => {
        setSelectionMode(allSelected ? 'manual' : 'all');
        setManualSelection(new Set());
    };

    const saveRules = useMutation({
        mutationFn: async (next: CatalogRules) => {
            // 后端一次只收一个设置项, 中途失败时把已经写进去的键退回原值, 避免半套规则生效。
            const previous = new Map(rulesToSettings(savedRules).map((setting) => [setting.key, setting.value]));
            const written: string[] = [];
            try {
                for (const setting of rulesToSettings(next)) {
                    await apiRequest('/api/v1/setting/set', { method: 'POST', body: setting });
                    written.push(setting.key);
                }
            } catch (cause) {
                for (const key of written) {
                    const value = previous.get(key);
                    if (value === undefined) continue;
                    await apiRequest('/api/v1/setting/set', { method: 'POST', body: { key, value } }).catch(() => undefined);
                }
                throw cause;
            }
        },
        onSuccess: async (_result, next) => {
            // 保留刚写入的值: 设置列表重新拉回来之前, 表单不能跳回旧缓存里的值。
            setDraft(next);
            await queryClient.invalidateQueries({ queryKey: ['settings', 'list'] });
            void queryClient.invalidateQueries({ queryKey: catalogModelsQueryOptions.queryKey });
            toast.success(t('rules.saved'));
        },
    });

    const generateGroups = useMutation({
        // 失败原因由结果清单就地展示, 声明关闭全局兜底提示避免重复。
        meta: { errorToast: false },
        mutationFn: async (targets: { model_id: string; raw_names: string[] }[]) => {
            const existing = await queryClient.fetchQuery({ ...groupListQueryOptions, staleTime: 0 });
            const plan = groupPlan(
                targets.map((target) => target.model_id),
                existing.map((group: Group) => group.name),
            );
            const byName = new Map(targets.map((target) => [target.model_id, target]));
            const outcomes: GroupOutcome[] = [];
            const touched: number[] = [];
            for (const name of plan.create) {
                const target = byName.get(name);
                try {
                    const created = await apiRequest<Group>('/api/v1/group/create', {
                        method: 'POST',
                        body: {
                            name,
                            mode: 'failover',
                            relay_config: {},
                            // 成员匹配的是渠道里的原始模型名, 表达式要用这一行的全部写法。
                            match_pattern: groupPattern(target?.raw_names ?? [], name),
                            items: [],
                        },
                    });
                    touched.push(created.id);
                    outcomes.push({ name, status: 'created', members: 0 });
                } catch (cause) {
                    outcomes.push({ name, status: 'failed', members: 0, error: errorMessage(cause) });
                }
            }
            for (const name of plan.existing) {
                const group = existing.find((item: Group) => item.name === name);
                if (group) touched.push(group.id);
                outcomes.push({ name, status: 'reused', members: 0 });
            }
            // 只补齐本次碰过的分组: 其它分组不需要为这一轮再写一次库。
            const results = touched.length > 0 ? await syncGroupsAfterChannelSync({ groupIds: touched }) : [];
            return { outcomes, results };
        },
        onSuccess: ({ outcomes, results }) => {
            void queryClient.invalidateQueries({ queryKey: groupListQueryOptions.queryKey });
            void queryClient.invalidateQueries({ queryKey: ['groups', 'detail'] });
            const added = new Map(results.map((result) => [result.groupName, result.added]));
            const merged: GroupOutcome[] = outcomes.map((outcome) => ({ ...outcome, members: added.get(outcome.name) ?? 0 }));
            setReport(merged);
            const created = merged.filter((item) => item.status === 'created').length;
            const reused = merged.filter((item) => item.status === 'reused').length;
            const failed = merged.filter((item) => item.status === 'failed').length;
            const members = merged.reduce((sum, item) => sum + item.members, 0);
            if (failed > 0) {
                toast.warning(t('groups.doneFailed', { created, reused, failed, members }));
            } else if (reused > 0) {
                toast.success(t('groups.doneReused', { created, reused, members }));
            } else {
                toast.success(t('groups.done', { created, members }));
            }
        },
    });

    const rulesPanel = (
        <>
            <div>
                <h2 className="text-sm font-bold text-foreground">{t('rules.title')}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t('rules.hint')}</p>
            </div>
            {!settingsReady && (
                <p className="text-xs text-muted-foreground">{settingsQuery.isError ? t('rules.settingsFailed') : t('rules.loading')}</p>
            )}
            <fieldset
                disabled={!settingsReady || saveRules.isPending}
                className="m-0 flex flex-col gap-5 border-0 p-0 disabled:opacity-60"
            >
                <label className="flex items-center justify-between gap-3" htmlFor="catalog-enabled">
                    <span className="text-sm">{t('rules.enabled')}</span>
                    <Switch
                        id="catalog-enabled"
                        checked={rules.enabled}
                        onCheckedChange={(checked) => setDraft({ ...rules, enabled: checked === true })}
                    />
                </label>

                <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-sm">
                            <CalendarClock className="size-4 text-muted-foreground" aria-hidden="true" />
                            {t('rules.releaseDays')}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                            {rules.releaseDays === 0 ? t('rules.releaseDaysAny') : t('rules.releaseDaysValue', { days: rules.releaseDays })}
                        </span>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={RELEASE_DAYS_STOPS.length - 1}
                        step={1}
                        value={nearestStopIndex(rules.releaseDays)}
                        onChange={(event) => setDraft({ ...rules, releaseDays: RELEASE_DAYS_STOPS[Number(event.target.value)] })}
                        aria-label={t('rules.releaseDays')}
                        className="w-full accent-primary"
                    />
                    {/* 时间轴下方是刻度说明, 不再单独进 Tab 顺序: 键盘用方向键调 range 即可, 状态由 aria-pressed 表达。 */}
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                        {RELEASE_DAYS_STOPS.map((days) => (
                            <button
                                key={days}
                                type="button"
                                tabIndex={-1}
                                aria-pressed={rules.releaseDays === days}
                                className={cn('rounded px-1 tabular-nums hover:text-foreground', rules.releaseDays === days && 'text-primary')}
                                onClick={() => setDraft({ ...rules, releaseDays: days })}
                            >
                                {days === 0 ? t('rules.releaseDaysAny') : days}
                            </button>
                        ))}
                    </div>
                </div>

                <label className="space-y-2" htmlFor="catalog-context">
                    <span className="text-sm">{t('rules.minContext')}</span>
                    <Input
                        id="catalog-context"
                        type="number"
                        min={0}
                        step={1000}
                        value={rules.minContext}
                        onChange={(event) => setDraft({ ...rules, minContext: Math.max(0, Number(event.target.value) || 0) })}
                        className="w-full rounded-xl"
                    />
                </label>

                <label className="flex items-center justify-between gap-3" htmlFor="catalog-tool-call">
                    <span className="text-sm">{t('rules.requireToolCall')}</span>
                    <Switch
                        id="catalog-tool-call"
                        checked={rules.requireToolCall}
                        onCheckedChange={(checked) => setDraft({ ...rules, requireToolCall: checked === true })}
                    />
                </label>

                <label className="flex items-center justify-between gap-3" htmlFor="catalog-deprecated">
                    <span className="text-sm">{t('rules.dropDeprecated')}</span>
                    <Switch
                        id="catalog-deprecated"
                        checked={rules.dropDeprecated}
                        onCheckedChange={(checked) => setDraft({ ...rules, dropDeprecated: checked === true })}
                    />
                </label>

                <div className="space-y-2">
                    <span className="text-sm">{t('rules.unknownPolicy')}</span>
                    <Select
                        value={rules.unknownPolicy}
                        onValueChange={(value) => setDraft({ ...rules, unknownPolicy: value === 'drop' ? 'drop' : 'keep' })}
                    >
                        <SelectTrigger className="w-full rounded-xl">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="keep">{t('rules.unknownKeep')}</SelectItem>
                            <SelectItem value="drop">{t('rules.unknownDrop')}</SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t('rules.unknownHint')}</p>
                </div>

                <div className="flex items-center gap-2">
                    <Button size="sm" className="rounded-xl" disabled={!dirty} onClick={() => saveRules.mutate(rules)}>
                        {t('rules.save')}
                    </Button>
                    <Button variant="ghost" size="sm" className="rounded-xl" disabled={!dirty} onClick={() => setDraft(null)}>
                        {t('rules.reset')}
                    </Button>
                </div>
            </fieldset>
        </>
    );

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 md:flex-row md:gap-6">
            <button
                type="button"
                className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm md:hidden"
                aria-expanded={rulesOpen}
                onClick={() => setRulesOpen((open) => !open)}
            >
                <span className="flex items-center gap-2">
                    {t('rules.toggle')}
                    {dirty && <span className="text-[11px] text-destructive">{t('rules.unsaved')}</span>}
                </span>
                <ChevronDown className={cn('size-4 transition-transform', rulesOpen && 'rotate-180')} aria-hidden="true" />
            </button>
            {rulesOpen && (
                <div className="flex shrink-0 flex-col gap-5 rounded-xl border border-border p-3 md:hidden">{rulesPanel}</div>
            )}

            <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto pb-4 md:flex">{rulesPanel}</aside>

            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
                    <div className="text-sm text-muted-foreground">
                        {summary
                            ? `${t('summary', { kept: keptRows.length, total: rows.length, catalog: summary.catalog_size })}${
                                  updatedAt ? ` · ${t('summaryUpdated', { time: updatedAt })}` : ''
                              }`
                            : t('loading')}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="ghost" size="sm" className="rounded-xl text-muted-foreground" disabled={keptRows.length === 0} onClick={toggleAll}>
                            {allSelected ? t('selection.none') : t('selection.all')}
                        </Button>
                        {dirty ? (
                            <span className="flex items-center gap-2 text-xs text-muted-foreground">
                                {t('rules.dirtyHint')}
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="rounded-xl"
                                    disabled={!settingsReady || saveRules.isPending}
                                    onClick={() => saveRules.mutate(rules)}
                                >
                                    {t('rules.saveFirst')}
                                </Button>
                            </span>
                        ) : (
                            <SyncAll label={t('actions.apply')} />
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="rounded-xl"
                            disabled={selectedNames.size === 0}
                            onClick={() => setConfirmGroups(true)}
                        >
                            <Sparkles className="size-4" aria-hidden="true" />
                            {t('actions.generate', { count: selectedNames.size })}
                        </Button>
                    </div>
                </div>

                {report && (
                    <div className="mb-3 shrink-0 rounded-xl border border-border p-3">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs font-medium">{t('groups.reportTitle')}</span>
                            <Button variant="ghost" size="sm" className="rounded-lg" onClick={() => setReport(null)}>
                                {t('groups.reportClose')}
                            </Button>
                        </div>
                        <ul className="space-y-1">
                            {report.map((item) => (
                                <li key={item.name} className="flex items-center gap-3 text-xs">
                                    <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
                                    {item.members > 0 && (
                                        <span className="shrink-0 tabular-nums text-muted-foreground">
                                            {t('groups.reportMembers', { count: item.members })}
                                        </span>
                                    )}
                                    <span className={cn('shrink-0', item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                                        {item.status === 'created'
                                            ? t('groups.reportCreated')
                                            : item.status === 'reused'
                                              ? t('groups.reportReused')
                                              : `${t('groups.reportFailed')}: ${item.error ?? ''}`}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                    {isPending ? (
                        <ListState kind="loading" />
                    ) : isError ? (
                        <ListState kind="error" errorDescription={errorMessage(error)} onRetry={() => void refetch()} />
                    ) : rows.length === 0 ? (
                        <ListState kind="empty" emptyText={t('empty')} />
                    ) : (
                        <div className="pb-6">
                            {groups.map(([developer, bucket]) => (
                                <section key={developer || 'unknown'} className="border-t border-border first:border-t-0">
                                    <header className="sticky top-0 z-10 flex items-baseline justify-between gap-2 bg-background/95 py-2 backdrop-blur">
                                        <h3 className="text-sm font-bold text-foreground">{developer || t('unknownDeveloper')}</h3>
                                        <span className="text-xs tabular-nums text-muted-foreground">
                                            {t('groupCount', { kept: bucket.filter((row) => row.verdict.kept).length, total: bucket.length })}
                                        </span>
                                    </header>
                                    <ul>
                                        {bucket.map(({ item, verdict }) => (
                                            <li
                                                key={item.model_id}
                                                className={cn('flex items-center gap-3 border-b border-border/60 py-2', !verdict.kept && 'text-muted-foreground')}
                                            >
                                                <Checkbox
                                                    checked={selectedNames.has(item.model_id)}
                                                    disabled={!verdict.kept}
                                                    onCheckedChange={() => toggleSelected(item.model_id)}
                                                    aria-label={item.model_id}
                                                />
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className={cn('truncate font-mono text-sm', !verdict.kept && 'line-through')}>
                                                            {item.model_id}
                                                        </span>
                                                        {item.raw_names.length > 1 && (
                                                            <span
                                                                className="shrink-0 text-[11px] text-muted-foreground"
                                                                title={item.raw_names.join('\n')}
                                                            >
                                                                {t('variants', { count: item.raw_names.length })}
                                                            </span>
                                                        )}
                                                        {item.status === 'deprecated' && (
                                                            <span className="shrink-0 text-[11px] text-destructive">{t('status.deprecated')}</span>
                                                        )}
                                                        {item.status === 'beta' && (
                                                            <span className="shrink-0 text-[11px] text-muted-foreground">{t('status.beta')}</span>
                                                        )}
                                                        {!item.matched && (
                                                            <span className="shrink-0 text-[11px] text-muted-foreground">{t('status.unknown')}</span>
                                                        )}
                                                    </div>
                                                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                                                        <span title={item.channels.join('\n')}>{t('channels', { count: item.channels.length })}</span>
                                                        {item.tool_call && <span>{t('capability.toolCall')}</span>}
                                                        {!verdict.kept && verdict.reason && (
                                                            <span className="text-destructive">{t(`reason.${verdict.reason}`)}</span>
                                                        )}
                                                    </div>
                                                </div>
                                                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                                                    {item.release_date || '—'}
                                                </span>
                                                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                                                    {formatContext(item.context_window)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <ConfirmDialog
                open={confirmGroups}
                onOpenChange={setConfirmGroups}
                title={t('groups.confirmTitle')}
                description={t('groups.confirmDescription', { count: selectedNames.size })}
                confirmLabel={t('groups.confirm')}
                onConfirm={() => {
                    const targets = rows
                        .filter((row) => selectedNames.has(row.item.model_id))
                        .map((row) => ({ model_id: row.item.model_id, raw_names: row.item.raw_names }));
                    return generateGroups.mutateAsync(targets).then(() => undefined);
                }}
            />
        </div>
    );
}

// nearestStopIndex 把保存下来的天数吸附到最近的刻度: 值不在刻度上时, 滑块停在最近的档位, 输入值本身不动。
function nearestStopIndex(releaseDays: number): number {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    RELEASE_DAYS_STOPS.forEach((days, index) => {
        const distance = Math.abs(days - releaseDays);
        if (distance < bestDistance) {
            best = index;
            bestDistance = distance;
        }
    });
    return best;
}

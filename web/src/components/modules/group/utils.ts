export function normalizeKey(value: string) {
    return value.trim().toLowerCase();
}

// MAX_MATCH_PATTERN_LENGTH 与后端 internal/op/group.go 的 maxMatchPatternLen 保持一致:
// 写入侧两侧同限, 超长表达式不会先被前端放行再被后端拒绝。
export const MAX_MATCH_PATTERN_LENGTH = 512;

export function memberKey(member: { channel_grant_id: number }) {
    return String(member.channel_grant_id);
}

export function matchesGroupName(modelName: string, groupKey: string) {
    if (!groupKey) return false;
    return modelName.toLowerCase().includes(groupKey);
}

// compileMatchPattern 把自动添加的匹配表达式编译成正则, 忽略大小写。
// 表达式为空时返回 regex = null, 由调用方回退到按分组名字面量包含匹配; 表达式非法时标记 invalid 而不是抛出。
export function compileMatchPattern(pattern: string): { regex: RegExp | null; invalid: boolean } {
    const trimmed = pattern.trim();
    if (!trimmed) return { regex: null, invalid: false };
    try {
        return { regex: new RegExp(trimmed, 'i'), invalid: false };
    } catch {
        return { regex: null, invalid: true };
    }
}

export function matchesAutoAdd(modelName: string, groupKey: string, regex: RegExp | null) {
    if (regex) return regex.test(modelName);
    return matchesGroupName(modelName, groupKey);
}

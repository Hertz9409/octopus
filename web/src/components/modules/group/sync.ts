import { apiRequest, errorMessage, queryClient } from '@/api/client';
import { channelGrantListQueryOptions, type ChannelGrantCandidate } from '@/api/channel';
import type { Group, GroupUpdateRequest } from '@/api/group';
import { groupListQueryOptions } from '@/api/queries';
import { compileMatchPattern, matchesAutoAdd, normalizeKey } from './utils';

// GroupSyncResult 是一个分组补齐成员的结果: 新增数量, 或未改动与失败的原因。
export type GroupSyncResult = {
    groupId: number;
    groupName: string;
    added: number;
    status: 'success' | 'skipped' | 'failed';
    reason?: 'no-match' | 'invalid-pattern';
    error?: string;
};

// additionsForGroup 按分组保存的匹配表达式挑选应当加入的授权, 已有成员一概保留(只加不减)。
// 表达式为空时回退到按分组名做字面量包含, 与编辑器里的「自动添加」共用同一套判断。
// 与编辑器一致, 不按 available 过滤: 渠道或凭据停用的授权照样补进来, 认领同一个模型,
// 等渠道恢复后即可直接转发, 无需再跑一次同步; 转发时后端本来就会剔除不可用成员。
export function additionsForGroup(group: Group, grants: ChannelGrantCandidate[]): number[] | 'invalid-pattern' {
    const { regex, invalid } = compileMatchPattern(group.match_pattern ?? '');
    if (invalid) return 'invalid-pattern';
    const groupKey = normalizeKey(group.name);
    const existing = new Set((group.items || []).map((item) => item.channel_grant_id));
    const additions: number[] = [];
    for (const grant of grants) {
        if (existing.has(grant.id)) continue;
        if (matchesAutoAdd(grant.model_name, groupKey, regex)) additions.push(grant.id);
    }
    return additions;
}

// syncGroupsAfterChannelSync 用最新的授权列表补齐分组, 逐个分组提交, 单个分组失败不影响其它分组。
// 提交的是「原成员 + 新增成员」的整体替换, 新成员排在末尾, 已有成员的顺序与优先级不变。
// 传 groupIds 时只处理这几个分组(模型库刚为它们建过成员), 未命中列表的 ID 会被忽略。
export async function syncGroupsAfterChannelSync(options: { groupIds?: number[] } = {}): Promise<GroupSyncResult[]> {
    const [groups, grants] = await Promise.all([
        queryClient.fetchQuery({ ...groupListQueryOptions, staleTime: 0 }),
        queryClient.fetchQuery({ ...channelGrantListQueryOptions, staleTime: 0 }),
    ]);
    const only = options.groupIds ? new Set(options.groupIds) : null;
    const results: GroupSyncResult[] = [];
    for (const group of groups) {
        if (only && !only.has(group.id)) continue;
        const additions = additionsForGroup(group, grants);
        if (additions === 'invalid-pattern') {
            results.push({ groupId: group.id, groupName: group.name, added: 0, status: 'skipped', reason: 'invalid-pattern' });
            continue;
        }
        if (additions.length === 0) {
            results.push({ groupId: group.id, groupName: group.name, added: 0, status: 'skipped', reason: 'no-match' });
            continue;
        }
        const items = [
            ...(group.items || []).map((item) => ({ channel_grant_id: item.channel_grant_id })),
            ...additions.map((channel_grant_id) => ({ channel_grant_id })),
        ];
        const payload: GroupUpdateRequest & { id: number } = { id: group.id, items };
        try {
            await apiRequest<Group>(`/api/v1/group/update/${group.id}`, { method: 'POST', body: payload });
            results.push({ groupId: group.id, groupName: group.name, added: additions.length, status: 'success' });
        } catch (error) {
            results.push({ groupId: group.id, groupName: group.name, added: 0, status: 'failed', error: errorMessage(error) });
        }
    }
    return results;
}

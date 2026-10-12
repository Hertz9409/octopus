import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiRequest } from './client';
import { queryClient } from './client';
import { groupListQueryOptions } from './queries';

// GroupMode 表示分组的手动或故障转移路由模式。
export type GroupMode = 'manual' | 'failover';

// GroupRelayConfig 保存分组 Relay 配置。
export interface GroupRelayConfig {
    member_max_attempts: number;
    member_retry_interval_seconds: number;
    member_non_stream_response_timeout_seconds: number;
    member_stream_first_event_timeout_seconds: number;
    member_cooldown_seconds: number;
    member_affinity_seconds: number;
}

// GroupItem 是分组内一条可路由的成员，对应一条渠道授权。
// 名称、所属渠道与可用性由后端补齐：授权是 (模型, 凭据) 的组合，界面只需展示与排序，无需再按主键回查。
export interface GroupItem {
    id: number;
    group_id: number;
    channel_grant_id: number;
    priority: number;
    channel_id: number;
    channel_name: string;
    model_name: string;
    key_name: string;
    protocols: number; // 该授权支持的 Protocol 位掩码。
    available: boolean; // 为假表示该成员当前无法转发，但仍会列出以便移除。
}

// GroupRuntime 是分组的实时路由状态。
// current_item_id 两种模式共用：手动模式下即人工指定的成员，故障转移模式下由 Relay 的路由决定。
export interface GroupRuntime {
    group_id: number;
    current_item_id: number;
    probe_item_id: number;
    affinity_until: number;
    cooldowns: Record<number, number>;
}

// Group 是客户端模型名称对应的渠道分组。
export interface Group {
    id: number;
    name: string;
    mode: GroupMode;
    relay_config: GroupRelayConfig;
    items: GroupItem[]; // 恒为数组，后端读取侧承诺不为 null。
    runtime: GroupRuntime; // 随分组一并返回；当前成员一律读 runtime.current_item_id。
}

// GroupItemInput 是提交的成员，按渠道授权主键引用；提交顺序即优先级顺序。
export interface GroupItemInput {
    channel_grant_id: number;
}

// GroupCreateRequest 是创建分组的请求。
export interface GroupCreateRequest {
    name: string;
    mode: GroupMode;
    relay_config: GroupRelayConfig;
    items: GroupItemInput[];
}

// GroupUpdateRequest 是分组配置、成员与当前成员的变更；items 为整体替换，按授权主键匹配保留已有成员。
// 只提交发生变化的字段；当前成员是分组的普通字段，与其余变更共用本请求。
export interface GroupUpdateRequest {
    name?: string;
    mode?: GroupMode;
    relay_config?: GroupRelayConfig;
    items?: GroupItemInput[];
    active_item_id?: number; // 手动模式指定的当前成员，0 表示取消选择。
}

// writeGroupCache 把一份分组写回列表与详情两处缓存，已存在则替换，不存在则插入。
// 写操作的响应与事件流都经由此处收敛，两处读的是同一份数据，无需再重新拉取列表。
function writeGroupCache(group: Group) {
    queryClient.setQueryData(groupListQueryOptions.queryKey, (current: Group[] | undefined) => {
        if (!current) return current;
        const next = current.filter((item) => item.id !== group.id);
        next.push(group);
        // 与后端 op.GroupList 的定序保持一致：API Key 表单的模型选择器没有排序开关，依赖列表自带的名称顺序。
        next.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return next;
    });
    queryClient.setQueryData(['groups', 'detail', group.id], group);
}

// removeGroupCache 从列表与详情两处缓存移除一个分组。
function removeGroupCache(id: number) {
    queryClient.setQueryData(groupListQueryOptions.queryKey, (current: Group[] | undefined) =>
        current?.filter((item) => item.id !== id)
    );
    queryClient.removeQueries({ queryKey: ['groups', 'detail', id] });
}

// useGroupList 获取全部分组，并由明确需要实时状态的页面控制是否订阅事件流。
export function useGroupList(enabled = true, eventsEnabled = false) {
    const query = useQuery({ ...groupListQueryOptions, enabled });

    useGroupEventStream(enabled && eventsEnabled);

    return query;
}

// useGroup 获取单个分组，供只关心一个分组的页面使用；实时状态按需订阅。
export function useGroup(id: number | undefined, enabled = true, eventsEnabled = false) {
    const query = useQuery({
        queryKey: ['groups', 'detail', id],
        queryFn: () => apiRequest<Group>(`/api/v1/group/get/${id}`),
        enabled: enabled && id !== undefined,
    });

    useGroupEventStream(enabled && eventsEnabled);

    return query;
}

// groupEventSource 是全应用共享的一条分组事件连接，由订阅方引用计数维持。
// 列表页与日志详情可能同时订阅，各自建连会白占浏览器对同域的连接数。
let groupEventSource: EventSource | null = null;
let groupEventRefCount = 0; // 当前订阅该连接的组件数量，归零时关闭连接。

// GroupEventStatus 表示共享事件连接的连接状态。
export type GroupEventStatus = 'connecting' | 'open' | 'closed';
let groupEventStatus: GroupEventStatus = 'closed';
const groupEventStatusListeners = new Set<() => void>();

function publishGroupEventStatus(next: GroupEventStatus) {
    if (groupEventStatus === next) return;
    groupEventStatus = next;
    for (const listener of groupEventStatusListeners) listener();
}

// subscribeGroupEventStatus 订阅连接状态变化，供 useSyncExternalStore 使用。
export function subscribeGroupEventStatus(listener: () => void) {
    groupEventStatusListeners.add(listener);

    return () => {
        groupEventStatusListeners.delete(listener);
    };
}

// getGroupEventStatus 读取当前连接状态。
export function getGroupEventStatus(): GroupEventStatus {
    return groupEventStatus;
}

// useGroupEventStream 订阅分组的变更事件与运行状态增量，并写回列表与详情两处缓存。
function useGroupEventStream(enabled: boolean) {
    useEffect(() => {
        if (!enabled) return;

        groupEventRefCount++;
        if (!groupEventSource) {
            publishGroupEventStatus('connecting');
            const source = new EventSource('./api/v1/group/events', { withCredentials: true });
            groupEventSource = source;
            source.addEventListener('changed', (event) => {
                writeGroupCache(JSON.parse((event as MessageEvent<string>).data) as Group);
            });
            source.addEventListener('deleted', (event) => {
                removeGroupCache(Number((event as MessageEvent<string>).data));
            });
            source.addEventListener('runtime', (event) => {
                const update = JSON.parse((event as MessageEvent<string>).data) as GroupRuntime;
                queryClient.setQueryData(groupListQueryOptions.queryKey, (current: Group[] | undefined) =>
                    current?.map((group) => group.id === update.group_id ? { ...group, runtime: update } : group)
                );
                queryClient.setQueryData(['groups', 'detail', update.group_id], (current: Group | undefined) =>
                    current && { ...current, runtime: update }
                );
            });
            // 后端不留事件历史，连接断开期间的变更无从补发，故每次连上都重新拉取一次对齐。
            // 拉取放在 onopen 而非 onerror: EventSource 自行重连，onerror 在每次失败时都会触发，
            // 写在那里会让断网期间反复全量重拉。
            source.onopen = () => {
                publishGroupEventStatus('open');
                queryClient.invalidateQueries({ queryKey: groupListQueryOptions.queryKey });
                queryClient.invalidateQueries({ queryKey: ['groups', 'detail'] });
            };
            // EventSource 会自行重连，这里只把状态标记为断开供页面提示。
            source.onerror = () => {
                publishGroupEventStatus('closed');
            };
        }

        return () => {
            groupEventRefCount--;
            if (groupEventRefCount > 0) return;
            groupEventSource?.close();
            groupEventSource = null;
            publishGroupEventStatus('closed');
        };
    }, [enabled]);
}

// useCreateGroup 创建分组。
export function useCreateGroup() {
    return useMutation({
        // 调用方在 mutate 时自行提示错误，声明关闭全局兜底提示避免重复。
        meta: { errorToast: false },
        mutationFn: (data: GroupCreateRequest) =>
            apiRequest<Group>('/api/v1/group/create', { method: 'POST', body: data }),
        onSuccess: writeGroupCache,
    });
}

// useUpdateGroup 更新分组配置、成员或当前成员，响应即变更后的完整分组。
export function useUpdateGroup() {
    return useMutation({
        // 所有调用方都在 mutate 时自行提示错误，声明关闭全局兜底提示避免重复。
        meta: { errorToast: false },
        mutationFn: ({ id, ...data }: GroupUpdateRequest & { id: number }) =>
            apiRequest<Group>(`/api/v1/group/update/${id}`, { method: 'POST', body: data }),
        onSuccess: writeGroupCache,
    });
}

// useDeleteGroup 删除分组。
export function useDeleteGroup() {
    return useMutation({
        mutationFn: (id: number) =>
            apiRequest<null>(`/api/v1/group/delete/${id}`, { method: 'DELETE' }),
        onSuccess: (_, id) => removeGroupCache(id),
    });
}

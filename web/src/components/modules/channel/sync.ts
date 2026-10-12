import { apiRequest } from '@/api/client';
import type { ChannelDetail, ChannelGrant, FetchModel } from '@/api/channel';
import { grantKey } from './state';

// ProbeOutcome 是一条凭据的探测结果; error 非空表示该凭据探测失败, 其结果不参与替换。
export type ProbeOutcome = {
    keyName: string;
    models: FetchModel[];
    error?: string;
};

// SyncStatus 是一次渠道同步的结论: 全部凭据成功 / 部分成功 / 失败 / 跳过(没有可用的凭据)。
export type SyncStatus = 'success' | 'partial' | 'failed' | 'skipped';

// SyncResult 是一次渠道同步的结果, 供界面逐条展示与汇总。
export type SyncResult = {
    channelId: number;
    channelName: string;
    status: SyncStatus;
    reason?: 'no-key' | 'probe-failed' | 'save-failed' | 'load-failed'; // 失败或跳过的原因, 文案由界面给出。
    message?: string; // 具体报错文本。
    modelsAdded: number;
    modelsRemoved: number;
    grants: number;
    keysProbed: number;
    keysFailed: number;
};

// 同步并发数: 一个渠道的探测本身已是两侧并发, 这里按渠道再并三路, 兼顾速度与上游限流。
const CONCURRENCY = 3;

function errorText(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
}

// probeConfig 取出探测用的渠道配置, 与保存后生效的字段完全一致, 只去掉与探测无关的主键与子表。
export function probeConfig(detail: ChannelDetail) {
    return {
        name: detail.name,
        dialect: detail.dialect,
        enabled: detail.enabled,
        base_url: detail.base_url,
        openai_chat_completion_path: detail.openai_chat_completion_path,
        openai_response_path: detail.openai_response_path,
        anthropic_message_path: detail.anthropic_message_path,
        proxy: detail.proxy,
        custom_header: detail.custom_header,
        channel_proxy: detail.channel_proxy,
        param_override: detail.param_override,
        match_regex: detail.match_regex,
    };
}

// buildSyncedDetail 把探测结果合并回渠道详情, 得到整体替换后的提交体:
// 模型列表是各探测成功凭据所报模型的并集, 顺序即凭据的探测顺序;
// 探测成功的凭据, 其授权就是它此次探到的模型, 已存在的组合保留原协议位(不覆盖界面上手勾的协议);
// 未探测(禁用或未填密钥)与探测失败的凭据, 只保留其模型仍在新列表里的授权, 避免临时停用凭据就丢授权。
// keepModels 是调用方要求排在探测结果之前的模型: 表单里只探测单个凭据的按钮用它留下其它凭据的模型,
// 使替换只作用于被探测凭据; 整渠道同步传空数组, 模型列表完全由探测结果决定。
export function buildSyncedDetail(
    detail: ChannelDetail,
    outcomes: ProbeOutcome[],
    keepModels: string[] = [],
): ChannelDetail {
    const models: string[] = [];
    const modelNames = new Set<string>();
    for (const name of keepModels) {
        if (modelNames.has(name)) continue;
        modelNames.add(name);
        models.push(name);
    }
    for (const outcome of outcomes) {
        if (outcome.error) continue;
        for (const model of outcome.models) {
            if (modelNames.has(model.name)) continue;
            modelNames.add(model.name);
            models.push(model.name);
        }
    }

    const existing = new Map<string, number>();
    for (const grant of detail.grants) {
        existing.set(grantKey(grant.model_name, grant.key_name), grant.protocols);
    }

    const grants: ChannelGrant[] = [];
    const covered = new Set<string>();
    const push = (modelName: string, keyName: string, protocols: number) => {
        const mapKey = grantKey(modelName, keyName);
        if (covered.has(mapKey)) return;
        covered.add(mapKey);
        grants.push({ model_name: modelName, key_name: keyName, protocols });
    };

    const probedKeys = new Set<string>();
    for (const outcome of outcomes) {
        if (outcome.error) continue;
        probedKeys.add(outcome.keyName);
        for (const model of outcome.models) {
            push(model.name, outcome.keyName, existing.get(grantKey(model.name, outcome.keyName)) ?? model.protocols);
        }
    }

    for (const grant of detail.grants) {
        if (probedKeys.has(grant.key_name)) continue;
        if (!modelNames.has(grant.model_name)) continue;
        push(grant.model_name, grant.key_name, grant.protocols);
    }

    return { ...detail, models, grants };
}

// syncChannel 同步单个渠道: 逐个启用且填了密钥的凭据探测, 探测结果事后整体替换模型与授权。
// 全部凭据都失败(或没有可用凭据)时不提交, 原模型与授权完全不动; 探测成功但一个模型都没有, 则提交空列表。
export async function syncChannel(detail: ChannelDetail): Promise<SyncResult> {
    const base: SyncResult = {
        channelId: detail.id,
        channelName: detail.name,
        status: 'skipped',
        modelsAdded: 0,
        modelsRemoved: 0,
        grants: 0,
        keysProbed: 0,
        keysFailed: 0,
    };

    // 只探测启用且填了密钥的凭据; 停用的凭据不请求上游, 其既有授权按模型是否仍存在保留。
    const keys = detail.keys.filter((key) => key.enabled && key.key.trim() !== '');
    if (keys.length === 0) {
        return { ...base, reason: 'no-key' };
    }

    const outcomes: ProbeOutcome[] = [];
    for (const key of keys) {
        try {
            const models = await apiRequest<FetchModel[]>('/api/v1/channel/fetch-model', {
                method: 'POST',
                body: { channel: probeConfig(detail), key: key.key },
            });
            outcomes.push({ keyName: key.name, models });
        } catch (cause) {
            outcomes.push({ keyName: key.name, models: [], error: errorText(cause) });
        }
    }

    const failed = outcomes.filter((outcome) => outcome.error);
    const keysFailed = failed.length;
    if (keysFailed === outcomes.length) {
        return { ...base, status: 'failed', reason: 'probe-failed', message: failed[0]?.error, keysProbed: outcomes.length, keysFailed };
    }

    const next = buildSyncedDetail(detail, outcomes);
    try {
        await apiRequest<ChannelDetail>('/api/v1/channel/update', { method: 'POST', body: next });
    } catch (cause) {
        return { ...base, status: 'failed', reason: 'save-failed', message: errorText(cause), keysProbed: outcomes.length, keysFailed };
    }

    const before = new Set(detail.models);
    const after = new Set(next.models);
    return {
        ...base,
        status: keysFailed === 0 ? 'success' : 'partial',
        modelsAdded: next.models.filter((name) => !before.has(name)).length,
        modelsRemoved: detail.models.filter((name) => !after.has(name)).length,
        grants: next.grants.length,
        keysProbed: outcomes.length,
        keysFailed,
    };
}

// SyncProgress 是一轮整渠道同步的进度, 存在模块级: 弹窗被 Esc 关掉后同步仍在继续,
// 重新打开时能接回同一份进度与结果, 也不会因为再次点击而重跑一轮。
export type SyncProgress = {
    running: boolean;
    total: number;
    results: SyncResult[];
};

let progress: SyncProgress = { running: false, total: 0, results: [] };
const progressListeners = new Set<() => void>();

function publishProgress(next: SyncProgress) {
    progress = next;
    for (const listener of progressListeners) listener();
}

// subscribeSyncProgress 与 getSyncProgress 供 useSyncExternalStore 读取模块级的同步进度。
export function subscribeSyncProgress(listener: () => void) {
    progressListeners.add(listener);
    return () => {
        progressListeners.delete(listener);
    };
}

export function getSyncProgress() {
    return progress;
}

// resetSyncProgress 清掉上一轮的结果, 让入口回到确认态; 正在跑的一轮不重置, 以免丢掉正在看的进度。
export function resetSyncProgress() {
    if (progress.running) return;
    publishProgress({ running: false, total: 0, results: [] });
}

// syncAllChannels 按渠道并发同步, 每完成一个渠道就把进度写到模块级, 供界面实时显示。
export async function syncAllChannels(channels: { channel_id: number; channel_name: string }[]): Promise<SyncResult[]> {
    if (progress.running) return progress.results;
    publishProgress({ running: true, total: channels.length, results: [] });
    const queue = [...channels];
    const results: SyncResult[] = [];
    const worker = async () => {
        for (;;) {
            const channel = queue.shift();
            if (!channel) return;
            let result: SyncResult;
            try {
                const detail = await apiRequest<ChannelDetail>(`/api/v1/channel/detail/${channel.channel_id}`);
                result = await syncChannel(detail);
            } catch (cause) {
                result = {
                    channelId: channel.channel_id,
                    channelName: channel.channel_name,
                    status: 'failed',
                    reason: 'load-failed',
                    message: errorText(cause),
                    modelsAdded: 0,
                    modelsRemoved: 0,
                    grants: 0,
                    keysProbed: 0,
                    keysFailed: 0,
                };
            }
            results.push(result);
            publishProgress({ running: true, total: channels.length, results: [...results] });
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    publishProgress({ running: false, total: channels.length, results: [...results] });
    return results;
}

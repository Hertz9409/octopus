import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiRequest } from './client';

/**
 * CatalogModelItem 是渠道在售模型与 models.dev 目录对照后的一行。
 * 同一个模型的多种写法(日期后缀、供应商前缀)归并成一行, 原始名字在 raw_names 里。
 */
export interface CatalogModelItem {
    model_id: string; // 展示用的模型名, 命中目录时取目录里的名字
    identity: string; // 归一化后的身份, 未命中目录时等于原始名字
    developer: string; // 研发商展示名, 空表示未识别
    release_date: string; // 发布日期, 空表示目录里没有
    tool_call: boolean;
    context_window: number;
    status: string; // 目录里的状态: 空、beta、deprecated 等
    channels: string[]; // 引用该模型的渠道名
    raw_names: string[]; // 渠道里的原始模型名
    matched: boolean; // 是否在目录里找到
}

export interface CatalogSummary {
    catalog_count: number; // 目录里的模型身份总数, 0 表示目录还是空的, 此时后端不过滤任何模型
    catalog_size: number; // 目录里的原始模型条目数
    updated_at: number; // Unix 秒, 0 表示目录还没更新过
}

export interface CatalogPayload {
    items: CatalogModelItem[];
    summary: CatalogSummary;
}

// catalogModelsQueryOptions 供模型库页面查询渠道模型与目录的对照结果。
export const catalogModelsQueryOptions = queryOptions({
    queryKey: ['catalog', 'models'],
    queryFn: () => apiRequest<CatalogPayload>('/api/v1/catalog/models'),
});

export function useCatalogModels() {
    return useQuery(catalogModelsQueryOptions);
}

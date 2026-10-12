import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { translate } from '@/lib/i18n';

// errorMessage 提取可展示的错误文案，网络异常等非 Error 值回退到通用提示。
export function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return translate('common.requestFailed');
}

// queryClient 管理整个前端应用共享的查询缓存和请求状态。
// mutation 未自行处理错误时统一弹提示，避免保存失败后界面毫无反馈。
// 调用方若在 mutate 时传了 onError，需要在对应 hook 上声明 meta.errorToast = false 以避免重复提示。
export const queryClient = new QueryClient({
    mutationCache: new MutationCache({
        onError: (error, _variables, _context, mutation) => {
            if (mutation.options.onError || mutation.meta?.errorToast === false) return;
            toast.error(errorMessage(error));
        },
    }),
    defaultOptions: {
        queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
        },
    },
});

type RequestOptions = {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    dispatchUnauthorized?: boolean;
    signal?: AbortSignal;
};

export class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

export const apiUnauthorizedEvent = 'api:unauthorized';

let apiKey: string | null = null;

export function setAPIKey(value: string | null) {
    apiKey = value;
}

// 相对于当前页面目录发送 API 请求，保留反向代理的子路径前缀。
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(options.body === undefined ? undefined : { 'Content-Type': 'application/json' });
    if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);

    const response = await fetch(new URL(`.${path}`, document.baseURI), {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'include',
        signal: options.signal,
    });
    const data = await response.json().catch(() => null) as { message?: string; data?: T } | null;
    if (!response.ok) {
        if (response.status === 401 && options.dispatchUnauthorized !== false && typeof window !== 'undefined') {
            window.dispatchEvent(new Event(apiUnauthorizedEvent));
        }
        throw new ApiError(response.status, data?.message || `${translate('common.requestFailed')} (${response.status})`);
    }
    return data?.data as T;
}

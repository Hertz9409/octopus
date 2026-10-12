import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { clearAppCacheAndReload } from '@/lib/app-cache';
import { isChunkLoadError } from '@/lib/chunk-error';

// ErrorBoundary 兜住渲染期异常，避免出错时整屏白屏。
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('Render error', error, info.componentStack);
    }

    private reset = () => this.setState({ error: null });

    render() {
        if (this.state.error) {
            return <ErrorFallback error={this.state.error} onRetry={this.reset} />;
        }

        return this.props.children;
    }
}

// ErrorFallback 展示崩溃提示：资源加载失败时引导重新加载，其余情况可原地重试。
function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
    const t = useTranslations('common');
    const chunkFailed = isChunkLoadError(error);

    return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6 text-center" role="alert">
            <div className="space-y-2">
                <p className="text-sm font-medium">{chunkFailed ? t('chunkFailedTitle') : t('crashTitle')}</p>
                <p className="text-sm text-muted-foreground">
                    {chunkFailed ? t('chunkFailedDescription') : t('crashDescription')}
                </p>
                <p className="max-w-md text-xs break-all text-muted-foreground/70">{error.message}</p>
            </div>
            <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                    {t('retry')}
                </Button>
                {chunkFailed ? (
                    <Button type="button" size="sm" onClick={() => void clearAppCacheAndReload()}>
                        {t('reload')}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

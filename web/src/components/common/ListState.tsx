import { AlertTriangle, Loader2, PackageOpen } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';

type ListStateKind = 'loading' | 'error' | 'empty';

// ListState 统一渲染列表的加载中、加载失败（可重试）与空数据占位。
export function ListState({
    kind,
    emptyText,
    errorDescription,
    onRetry,
}: {
    kind: ListStateKind;
    emptyText?: string;
    errorDescription?: string;
    onRetry?: () => void;
}) {
    const t = useTranslations('common');

    if (kind === 'loading') {
        return (
            <div className="flex flex-col items-center gap-3 text-muted-foreground" role="status">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                <p className="text-sm">{t('loading')}</p>
            </div>
        );
    }

    if (kind === 'error') {
        return (
            <div className="flex flex-col items-center gap-3 text-center" role="alert">
                <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
                <div>
                    <p className="text-sm font-medium text-foreground">{t('loadFailed')}</p>
                    {errorDescription ? (
                        <p className="mt-1 max-w-80 text-xs break-words text-muted-foreground">{errorDescription}</p>
                    ) : null}
                </div>
                {onRetry ? (
                    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                        {t('retry')}
                    </Button>
                ) : null}
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
            <PackageOpen className="size-5" aria-hidden="true" />
            <p className="text-sm">{emptyText}</p>
        </div>
    );
}

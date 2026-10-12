import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/api/client';

// ConfirmDialog 是破坏性操作的统一确认弹窗：Esc 取消、焦点落在取消按钮、失败留在原地显示原因。
export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    destructive = false,
    onConfirm,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: ReactNode;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => Promise<void> | void;
}) {
    const t = useTranslations('common');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleOpenChange = (next: boolean) => {
        // 执行中不允许通过 Esc 或遮罩关闭，避免操作状态与界面脱节。
        if (pending) return;
        if (!next) setError(null);
        onOpenChange(next);
    };

    const handleConfirm = async () => {
        setPending(true);
        setError(null);
        try {
            await onConfirm();
            onOpenChange(false);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    };

    return (
        <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
            <AlertDialog.Portal>
                <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
                <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-lg">
                    <AlertDialog.Title className="text-sm font-medium">{title}</AlertDialog.Title>
                    {description ? (
                        <AlertDialog.Description asChild>
                            <div className="mt-2 space-y-2 text-sm text-muted-foreground">{description}</div>
                        </AlertDialog.Description>
                    ) : null}
                    {error ? <p className="mt-3 text-xs break-words text-destructive">{error}</p> : null}
                    <div className="mt-5 flex justify-end gap-2">
                        <AlertDialog.Cancel asChild>
                            <Button type="button" variant="outline" size="sm" disabled={pending}>
                                {t('cancel')}
                            </Button>
                        </AlertDialog.Cancel>
                        <Button
                            type="button"
                            size="sm"
                            variant={destructive ? 'destructive' : 'default'}
                            disabled={pending}
                            onClick={() => void handleConfirm()}
                        >
                            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                            {confirmLabel}
                        </Button>
                    </div>
                </AlertDialog.Content>
            </AlertDialog.Portal>
        </AlertDialog.Root>
    );
}

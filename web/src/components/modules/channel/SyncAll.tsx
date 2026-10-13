import { useEffect, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, MinusCircle, RefreshCw, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { toast } from 'sonner';
import { useChannelStats } from '@/api/channel';
import { errorMessage } from '@/api/client';
import { groupListQueryOptions } from '@/api/queries';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
    MorphingDialog,
    MorphingDialogClose,
    MorphingDialogContainer,
    MorphingDialogContent,
    MorphingDialogDescription,
    MorphingDialogTitle,
    MorphingDialogTrigger,
    useMorphingDialog,
} from '@/components/ui/morphing-dialog';
import {
    getSyncProgress,
    resetSyncProgress,
    subscribeSyncProgress,
    syncAllChannels,
    type SyncResult,
    type SyncStatus,
} from './sync';
import { syncGroupsAfterChannelSync, type GroupSyncResult } from '../group/sync';

const STATUS_ICON = {
    success: CheckCircle2,
    partial: AlertTriangle,
    failed: XCircle,
    skipped: MinusCircle,
} as const;

const STATUS_TONE: Record<SyncStatus, string> = {
    success: 'text-emerald-500',
    partial: 'text-amber-500',
    failed: 'text-destructive',
    skipped: 'text-muted-foreground',
};

// SyncAll 是「同步全部模型」入口: 不传 label 时渲染成渠道页工具栏上的图标按钮, 传 label 则渲染成带文字的普通按钮,
// 供模型库页面复用同一套确认、进度与结果流程。弹窗内容只在打开期间挂载, 每次打开都是全新一轮。
type SyncAllProps = { label?: string };

export function SyncAll({ label }: SyncAllProps = {}) {
    const t = useTranslations('toolbar');
    const title = label ?? t('syncModels');

    return (
        <MorphingDialog>
            <MorphingDialogTrigger
                label={title}
                className={
                    label
                        ? buttonVariants({ variant: 'outline', size: 'sm', className: 'rounded-xl' })
                        : buttonVariants({
                              variant: 'ghost',
                              size: 'icon',
                              className: 'rounded-xl text-muted-foreground transition-none hover:bg-transparent hover:text-foreground',
                          })
                }
            >
                {label ? (
                    <>
                        <RefreshCw className="size-4" aria-hidden="true" />
                        <span className="text-xs">{title}</span>
                    </>
                ) : (
                    <>
                        <RefreshCw className="size-4" aria-hidden="true" />
                        <span className="sr-only">{title}</span>
                    </>
                )}
            </MorphingDialogTrigger>
            <MorphingDialogContainer>
                <SyncAllContent />
            </MorphingDialogContainer>
        </MorphingDialog>
    );
}

// countByStatus 汇总各状态的数量, 供说明文案与结束提示共用。
function countByStatus(results: SyncResult[]): Record<SyncStatus, number> {
    const counts: Record<SyncStatus, number> = { success: 0, partial: 0, failed: 0, skipped: 0 };
    for (const result of results) counts[result.status] += 1;
    return counts;
}

// SyncAllContent 承载确认、进度与结果三段。
// 进度存在模块级: 弹窗被 Esc 关掉后同步仍在跑, 重新打开能接着看进度与结果; 运行中也不允许点外部关闭, 避免误触。
function SyncAllContent() {
    const t = useTranslations('channel.sync');
    const { setIsOpen } = useMorphingDialog();
    const queryClient = useQueryClient();
    const { data } = useChannelStats();
    const channels = data ?? [];
    const { running, total, results } = useSyncExternalStore(subscribeSyncProgress, getSyncProgress);
    const phase = running ? 'running' : results.length > 0 ? 'done' : 'confirm';
    const counts = countByStatus(results);
    const [groupPhase, setGroupPhase] = useState<'idle' | 'running'>('idle');
    const [groupResults, setGroupResults] = useState<GroupSyncResult[]>([]);

    // 每次打开都回到确认态: 上一轮的结果已经看过, 清掉后才能重新开始; 正在跑的一轮不清。
    useEffect(() => {
        resetSyncProgress();
    }, []);

    // 同步走的是与手工编辑同一套接口, 不改动 react-query 缓存里的整份配置, 结束后统一失效相关查询。
    // 结束提示用 toast: 弹窗可能已被 Esc 关掉, 结果不能只留在弹窗里。
    const start = async () => {
        await syncAllChannels(channels);
        queryClient.invalidateQueries({ queryKey: ['channels'] });
        queryClient.invalidateQueries({ queryKey: groupListQueryOptions.queryKey });
        const final = countByStatus(getSyncProgress().results);
        const summary = t('summary', final);
        if (final.failed > 0 || final.partial > 0) {
            toast.warning(summary);
        } else {
            toast.success(summary);
        }
    };

    // 渠道模型同步完成后按各分组保存的匹配表达式补成员: 只新增, 不删除已有成员, 也不改动它们的顺序。
    // 拉取分组与授权列表失败时不能把按钮留在「正在更新分组」: 复位与提示都放在 finally/catch 里。
    const updateGroups = async () => {
        setGroupPhase('running');
        try {
            const next = await syncGroupsAfterChannelSync();
            setGroupResults(next);
            queryClient.invalidateQueries({ queryKey: groupListQueryOptions.queryKey });
            // 分组详情缓存由 SSE 维护, 这里顺带失效一次, 免得事件流断开时日志详情停留在旧成员上。
            queryClient.invalidateQueries({ queryKey: ['groups', 'detail'] });
            const added = next.reduce((sum, item) => sum + item.added, 0);
            const groups = next.filter((item) => item.status === 'success').length;
            const summary = added === 0 ? t('groupUpdateNone') : t('groupUpdateSummary', { added, groups });
            if (next.some((item) => item.status === 'failed')) {
                toast.warning(summary);
            } else {
                toast.success(summary);
            }
        } catch (error) {
            toast.error(t('groupUpdateFailed'), { description: errorMessage(error) });
        } finally {
            setGroupPhase('idle');
        }
    };

    return (
        <MorphingDialogContent
            dismissOnClickOutside={phase !== 'running'}
            className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-xl flex-col overflow-hidden rounded-3xl bg-card px-6 py-5 text-card-foreground"
        >
            {phase !== 'running' && (
                <MorphingDialogClose className="top-4 right-5 text-muted-foreground hover:text-foreground transition-colors" />
            )}
            <MorphingDialogTitle className="pr-8 text-sm font-semibold">
                {t('title')}
            </MorphingDialogTitle>
            <MorphingDialogDescription className="mt-2 text-xs text-muted-foreground">
                {phase === 'done'
                    ? t('summary', counts)
                    : channels.length === 0
                        ? t('empty')
                        : t('description')}
            </MorphingDialogDescription>

            {phase === 'confirm' && channels.length > 0 && (
                <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                    <li>{t('noticeScope', { count: channels.length })}</li>
                    <li>{t('noticeReplace')}</li>
                    <li>{t('noticeCascade')}</li>
                    <li>{t('noticeBackup')}</li>
                </ul>
            )}

            {phase !== 'confirm' && (
                <div className="mt-4 shrink-0 space-y-2">
                    <Progress value={total === 0 ? 0 : Math.round((results.length / total) * 100)} />
                    <p className="text-xs text-muted-foreground">{t('progress', { done: results.length, total })}</p>
                </div>
            )}

            {results.length > 0 && (
                <div className="mt-3 min-h-0 flex-1 divide-y divide-border overflow-auto">
                    {results.map((result) => (
                        <SyncRow key={result.channelId} result={result} />
                    ))}
                </div>
            )}

            {phase === 'done' && (
                <div className="mt-4 shrink-0 rounded-2xl border border-border/60 bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{t('groupUpdateHint')}</p>
                    {groupResults.length > 0 && (
                        <ul className="mt-2 max-h-32 space-y-1 overflow-auto text-[11px]">
                            {groupResults.map((item) => {
                                const detail = item.status === 'success'
                                    ? t('groupResultAdded', { count: item.added })
                                    : item.status === 'failed'
                                        ? item.error
                                            ? `${t('groupResultFailed')} · ${item.error}`
                                            : t('groupResultFailed')
                                        : item.reason === 'invalid-pattern'
                                            ? t('groupResultInvalid')
                                            : t('groupResultNoMatch');
                                return (
                                    <li key={item.groupId} className="flex items-center justify-between gap-3">
                                        <span className="truncate text-muted-foreground">{item.groupName}</span>
                                        <span className={cn('shrink-0', item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                                            {detail}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={updateGroups}
                        disabled={groupPhase === 'running'}
                    >
                        {groupPhase === 'running' ? t('groupUpdating') : t('groupUpdate')}
                    </Button>
                </div>
            )}

            <div className="mt-4 flex shrink-0 justify-end gap-2">
                {phase === 'confirm' && (
                    <>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setIsOpen(false)}>
                            {t('cancel')}
                        </Button>
                        <Button type="button" size="sm" onClick={start} disabled={channels.length === 0}>
                            {t('start')}
                        </Button>
                    </>
                )}
                {phase === 'running' && (
                    <span className="text-xs text-muted-foreground">{t('running')}</span>
                )}
                {phase === 'done' && (
                    <Button type="button" size="sm" onClick={() => setIsOpen(false)}>
                        {t('close')}
                    </Button>
                )}
            </div>
        </MorphingDialogContent>
    );
}

// SyncRow 展示单个渠道的同步结果: 状态图标 + 渠道名 + 增删计数或失败原因。
function SyncRow({ result }: { result: SyncResult }) {
    const t = useTranslations('channel.sync');
    const Icon = STATUS_ICON[result.status];
    const label: Record<SyncStatus, string> = {
        success: t('statusSuccess'),
        partial: t('statusPartial'),
        failed: t('statusFailed'),
        skipped: t('statusSkipped'),
    };

    let detail: string;
    if (result.status === 'skipped') {
        detail = t('reasonNoKey');
    } else if (result.reason === 'probe-failed') {
        detail = t('reasonProbeFailed');
    } else if (result.reason === 'save-failed') {
        detail = t('reasonSaveFailed');
    } else if (result.reason === 'load-failed') {
        detail = t('reasonLoadFailed');
    } else if (result.keysFailed > 0) {
        detail = t('countsPartial', {
            added: result.modelsAdded,
            removed: result.modelsRemoved,
            failed: result.keysFailed,
        });
    } else {
        detail = t('counts', { added: result.modelsAdded, removed: result.modelsRemoved });
    }

    return (
        <div className="flex items-start gap-2.5 py-2">
            <Icon className={cn('mt-0.5 size-3.5 shrink-0', STATUS_TONE[result.status])} aria-hidden="true" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{result.channelName}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                    {result.message ? `${detail} · ${result.message}` : detail}
                </span>
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{label[result.status]}</span>
        </div>
    );
}

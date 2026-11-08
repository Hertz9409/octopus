import { CircleAlert, CircleCheck, CircleHelp, CircleX } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChannelHealth, ChannelModelHealth } from '@/api/channel';

type HealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

const STATUS_ICON = {
    healthy: CircleCheck,
    degraded: CircleAlert,
    down: CircleX,
    unknown: CircleHelp,
} as const;

const STATUS_TONE: Record<HealthStatus, string> = {
    healthy: 'text-emerald-500',
    degraded: 'text-amber-500',
    down: 'text-destructive',
    unknown: 'text-muted-foreground/60',
};

// formatHealthTime 把 Unix 毫秒格式成本地时分秒，供悬浮详情展示检测时间。
function formatHealthTime(at: number): string {
    if (!at) return '-';
    return new Date(at).toLocaleTimeString();
}

// HealthDot 展示渠道健康状态点，悬浮给出探测与被动流量的明细。
// 状态口径由后端定稿：5 分钟内的手动探测优先，其次看最近 5 分钟真实流量；两者都无信号时为未知。
export function HealthDot({ health, className }: { health?: ChannelHealth | null; className?: string }) {
    const t = useTranslations('channel.health');
    const status: HealthStatus = health?.status ?? 'unknown';
    const Icon = STATUS_ICON[status];

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className={cn('inline-flex shrink-0 items-center justify-center', className)} aria-label={t(`status.${status}`)}>
                    <Icon className={cn('size-4', STATUS_TONE[status])} />
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8} className="max-w-64 space-y-1 text-[11px] leading-5">
                <div className="font-medium">{t(`status.${status}`)}</div>
                {health?.probe ? (
                    <>
                        <div className="text-muted-foreground">
                            {t('probeSummary', {
                                time: formatHealthTime(health.probe.at),
                                latency: health.probe.latency_ms,
                                ok: health.probe.keys_ok,
                                total: health.probe.keys_total,
                            })}
                        </div>
                        {health.probe.error ? <div className="break-all text-destructive">{health.probe.error}</div> : null}
                    </>
                ) : (
                    <div className="text-muted-foreground">{t('noProbe')}</div>
                )}
                {health && health.traffic.success + health.traffic.failure > 0 ? (
                    <div className="text-muted-foreground">
                        {t('trafficSummary', { success: health.traffic.success, failed: health.traffic.failure })}
                    </div>
                ) : null}
            </TooltipContent>
        </Tooltip>
    );
}

// ModelHealthDot 展示模型级被动健康状态点；模型级只来自真实流量，空闲模型没有状态。
export function ModelHealthDot({ health }: { health?: ChannelModelHealth | null }) {
    const t = useTranslations('channel.health');
    const status: HealthStatus = health?.status ?? 'unknown';
    const Icon = STATUS_ICON[status];

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex shrink-0 items-center justify-center" aria-label={t(`status.${status}`)}>
                    <Icon className={cn('size-3.5', STATUS_TONE[status])} />
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8} className="max-w-60 space-y-1 text-[11px] leading-5">
                <div className="font-medium">{t(`status.${status}`)}</div>
                {health && health.traffic.success + health.traffic.failure > 0 ? (
                    <div className="text-muted-foreground">
                        {t('trafficSummary', { success: health.traffic.success, failed: health.traffic.failure })}
                    </div>
                ) : (
                    <div className="text-muted-foreground">{t('noTraffic')}</div>
                )}
            </TooltipContent>
        </Tooltip>
    );
}

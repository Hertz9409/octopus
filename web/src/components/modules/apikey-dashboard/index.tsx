import { useTranslations } from 'use-intl';
import { useTheme } from '@/provider/theme';
import { toast } from 'sonner';
import { useAPIKeyDashboardStats } from '@/api/apikey';
import { useAuthStore } from '@/api/user';
import { useSettingStore } from '@/stores/setting';
import { AnimatedNumber } from '@/components/common/AnimatedNumber';
import Logo from '@/components/modules/logo';
import { CopyIconButton } from '@/components/common/CopyButton';
import { useCopyToClipboard } from '@uidotdev/usehooks';
import { useCallback } from 'react';
import type { JSX } from 'react';
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    CheckCircle,
    XCircle,
    KeyRound,
    LogOut,
    Calendar,
    Sun,
    Moon,
    Languages,
    Zap,
    Layers,
    Clock,
    Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/api/client';
import dayjs from 'dayjs';

export function APIKeyDashboard() {
    const t = useTranslations('apiKeyDashboard');
    const { data, error, isPending } = useAPIKeyDashboardStats();
    const { logout } = useAuthStore();
    const { theme, setTheme } = useTheme();
    const { locale, setLocale } = useSettingStore();
    const [, copyToClipboard] = useCopyToClipboard();

    const copyWithToast = useCallback(
        async (text: string, label: string) => {
            try {
                await copyToClipboard(text);
                toast.success(`${label} copied`);
            } catch (copyError) {
                toast.error(t('error'), { description: errorMessage(copyError) });
            }
        },
        [copyToClipboard, t]
    );

    if (isPending) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center space-y-4">
                    <p className="text-destructive font-medium">{t('error')}</p>
                    {/* 区分「Key 失效」与「服务不可达」: 后端给的 message 要原样带出来。 */}
                    {error && <p className="text-sm text-muted-foreground">{errorMessage(error)}</p>}
                    <Button onClick={logout} variant="outline" className="rounded-xl">
                        {t('logout')}
                    </Button>
                </div>
            </div>
        );
    }

    const { stats, info } = data;

    // Expiry calculations
    const expireAt = info.expire_at ? dayjs.unix(info.expire_at) : null;
    const isExpired = expireAt ? expireAt.isBefore(dayjs()) : false;
    const daysUntilExpire = expireAt ? expireAt.diff(dayjs(), 'day') : null;

    const supportedModelButtons: JSX.Element[] = info.supported_models.map((model) => (
        <Button
            key={model}
            variant="secondary"
            size="sm"
            className="h-8 rounded-lg px-3 text-sm transition-colors hover:bg-primary hover:text-primary-foreground"
            onClick={() => void copyWithToast(model, model)}
        >
            {model}
        </Button>
    ));

    const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
    const toggleLanguage = () => {
        if (locale === 'zh_hans') setLocale('zh_hant');
        else if (locale === 'zh_hant') setLocale('en');
        else setLocale('zh_hans');
    };

    return (
        <div className="mx-auto max-w-6xl px-3 md:px-6">
            {/* Header - Consistent with app.tsx */}
            <header className="my-6 flex items-center gap-2 px-2">
                <Logo size={48} />
                <h1 className="ml-2 flex-1 truncate text-2xl font-bold tracking-tight">octopus</h1>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" onClick={toggleTheme} className="rounded-xl hover:bg-accent">
                        <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                        <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={toggleLanguage} className="rounded-xl hover:bg-accent">
                        <Languages className="size-4" />
                    </Button>
                    <div className="w-px h-6 bg-border mx-1" />
                    <Button variant="ghost" size="icon" onClick={logout} className="rounded-xl hover:bg-destructive/10 hover:text-destructive">
                        <LogOut className="size-4" />
                    </Button>
                </div>
            </header>

            <main className="mb-10">
                <div className="space-y-6">
                    {/* Hero: Identity + Limits */}
                    <div className="overflow-hidden rounded-3xl border bg-card">
                        {/* Key Info */}
                        <div className="p-6 md:p-8 flex flex-col relative">
                            <KeyRound aria-hidden="true" className="pointer-events-none absolute top-6 right-6 h-27 w-27 text-muted-foreground/10" />
                            <h2 className="text-2xl font-bold truncate pr-16">{info.name}</h2>
                            <div className="mt-4 flex items-center gap-2 rounded-xl border border-border/50 bg-muted/50 p-3">
                                <code className="flex-1 font-mono text-sm truncate">
                                    {info.api_key.slice(0, 11)}********{info.api_key.slice(-4)}
                                </code>
                                <CopyIconButton
                                    text={info.api_key}
                                    className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary transition-all hover:bg-primary hover:text-primary-foreground active:scale-95"
                                    copyIconClassName="size-4"
                                    checkIconClassName="size-4"
                                />
                            </div>
                            {/* Expiry inline */}
                            <div className="mt-auto pt-6 text-sm">
                                <div className="flex items-center justify-between">
                                    <span className="flex items-center gap-2 text-muted-foreground"><Calendar className="w-4 h-4" />{t('expireAt')}</span>
                                    {expireAt ? (
                                        <span className={`font-medium ${isExpired ? 'text-destructive' : ''}`}>
                                            {expireAt.format('YYYY-MM-DD')}
                                            {!isExpired && daysUntilExpire !== null && <span className="ml-2 text-xs bg-secondary px-2 py-0.5 rounded-full">{daysUntilExpire} {t('daysLeft')}</span>}
                                            {isExpired && <span className="ml-2 text-xs bg-destructive/10 text-destructive px-2 py-0.5 rounded-full">{t('expired')}</span>}
                                        </span>
                                    ) : (
                                        <span className="font-medium">{t('neverExpire')}</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Row 2: Request Health */}
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                        <div className="rounded-2xl border bg-card p-5">
                            <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                                <CheckCircle className="size-4 text-chart-2" />
                                {t('successRequests')}
                            </div>
                            <div className="text-2xl font-bold">
                                <AnimatedNumber value={stats.request_success.formatted.value} />
                                <span className="ml-1 text-sm font-normal text-muted-foreground">{stats.request_success.formatted.unit}</span>
                            </div>
                        </div>

                        <div className="rounded-2xl border bg-card p-5">
                            <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                                <XCircle className="size-4 text-destructive" />
                                {t('failedRequests')}
                            </div>
                            <div className="text-2xl font-bold">
                                <AnimatedNumber value={stats.request_failed.formatted.value} />
                                <span className="ml-1 text-sm font-normal text-muted-foreground">{stats.request_failed.formatted.unit}</span>
                            </div>
                        </div>

                        <div className="rounded-2xl border bg-card p-5">
                            <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                                <Zap className="size-4 text-chart-4" />
                                {t('requestCount')}
                            </div>
                            <div className="text-2xl font-bold">
                                <AnimatedNumber value={stats.request_count.formatted.value} />
                                <span className="ml-1 text-sm font-normal text-muted-foreground">{stats.request_count.formatted.unit}</span>
                            </div>
                        </div>

                        <div className="rounded-2xl border bg-card p-5">
                            <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                                <Clock className="size-4 text-chart-5" />
                                {t('timeConsumed')}
                            </div>
                            <div className="text-2xl font-bold">
                                <AnimatedNumber value={stats.wait_time.formatted.value} />
                                <span className="ml-1 text-sm font-normal text-muted-foreground">{stats.wait_time.formatted.unit}</span>
                            </div>
                        </div>
                    </div>

                    {/* Row 3: Token breakdown */}
                    <div className="rounded-2xl border bg-card p-6">
                            <div className="flex items-center gap-2 mb-4">
                                <Zap className="w-5 h-5 text-chart-4" />
                                <span className="font-semibold">{t('totalToken')}</span>
                                <span className="ml-auto text-2xl font-bold"><AnimatedNumber value={stats.total_token.formatted.value} /><span className="text-sm font-normal text-muted-foreground ml-1">{stats.total_token.formatted.unit}</span></span>
                            </div>
                            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-border/50">
                                <div>
                                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1"><ArrowDownToLine className="w-3.5 h-3.5" />{t('inputTokens')}</div>
                                    <div className="text-lg font-semibold"><AnimatedNumber value={stats.input_token.formatted.value} /><span className="text-xs font-normal text-muted-foreground ml-1">{stats.input_token.formatted.unit}</span></div>
                                </div>
                                <div>
                                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1"><ArrowUpFromLine className="w-3.5 h-3.5" />{t('outputTokens')}</div>
                                    <div className="text-lg font-semibold"><AnimatedNumber value={stats.output_token.formatted.value} /><span className="text-xs font-normal text-muted-foreground ml-1">{stats.output_token.formatted.unit}</span></div>
                                </div>
                            </div>
                        </div>

                    {/* Supported Models */}
                    {info.supported_models.length > 0 && (
                        <div className="rounded-2xl border bg-card p-6">
                            <div className="flex items-center gap-2 mb-4">
                                <Layers className="w-5 h-5 text-chart-3" />
                                <span className="font-semibold">{t('supportedModels')}</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {supportedModelButtons}
                            </div>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}

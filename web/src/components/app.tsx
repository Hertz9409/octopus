import { lazy, Suspense, useDeferredValue, useEffect, useState, type ReactNode } from 'react';
import { isCancelledError, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useAuth } from '@/api/user';
import {
    apiKeyDashboardStatsQueryOptions,
    apiKeyListQueryOptions,
    channelStatsQueryOptions,
    groupListQueryOptions,
    modelListQueryOptions,
    statsDailyQueryOptions,
    statsHourlyQueryOptions,
    statsTotalQueryOptions,
} from '@/api/queries';
import { AppShell } from '@/components/app-shell';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { LoginForm } from '@/components/modules/login';
import { APIKeyDashboard } from '@/components/modules/apikey-dashboard';
import { useAppStore } from '@/stores/app';
import { pageImports } from '@/lib/page-preload';
import { retryImport } from '@/lib/retry-import';
import { useServiceWorkerUpdate } from '@/lib/pwa';

// INIT_TIMEOUT_MS 是首屏初始化请求的等待上限。
const INIT_TIMEOUT_MS = 8000;

// 页面和顶栏操作共用 pageImports 中的懒加载模块，加载失败时重试一次再交给错误边界。
const Home = lazy(() => retryImport(() => pageImports.home()).then((module) => ({ default: module.Home })));
const Channel = lazy(() => retryImport(() => pageImports.channel()).then((module) => ({ default: module.Channel })));
const Group = lazy(() => retryImport(() => pageImports.group()).then((module) => ({ default: module.Group })));
const Model = lazy(() => retryImport(() => pageImports.model()).then((module) => ({ default: module.Model })));
const Log = lazy(() => retryImport(() => pageImports.log()).then((module) => ({ default: module.Log })));
const Setting = lazy(() => retryImport(() => pageImports.setting()).then((module) => ({ default: module.Setting })));
const HomeActions = lazy(() => retryImport(() => pageImports.home()).then((module) => ({ default: module.HomeActions })));
const ChannelActions = lazy(() => retryImport(() => pageImports.channel()).then((module) => ({ default: module.ChannelActions })));
const GroupActions = lazy(() => retryImport(() => pageImports.group()).then((module) => ({ default: module.GroupActions })));
const ModelActions = lazy(() => retryImport(() => pageImports.model()).then((module) => ({ default: module.ModelActions })));

// InitialLoadingGate 在当前界面提交后淡出并移除 HTML 首屏加载动画。
function InitialLoadingGate({ children }: { children: ReactNode }) {
    useEffect(() => {
        const loader = document.getElementById('initial-loader');
        if (!loader || loader.dataset.state === 'hidden') return;

        loader.dataset.state = 'hidden';
        loader.classList.add('octo-hide');
        window.setTimeout(() => loader.remove(), 220);
    }, []);

    return children;
}

// PageFallback 在懒加载页面就绪前占位，避免整块内容空白。
function PageFallback() {
    const t = useTranslations('common');

    return (
        <div className="flex h-40 items-center justify-center" role="status">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">{t('loading')}</span>
        </div>
    );
}

// ActionFallback 为顶栏操作预留一个图标按钮的位置，避免模块到位时工具栏跳动。
function ActionFallback() {
    return <div className="size-9 animate-pulse rounded-md bg-accent/50" aria-hidden="true" />;
}

// AppContainer 根据认证状态渲染登录页、API Key 页面或普通用户应用。
export function AppContainer() {
    const t = useTranslations('common');
    const prefersReducedMotion = useReducedMotion() ?? false;
    const { isAuthenticated, isAPIKeyAuth, isLoading: authLoading } = useAuth();
    const queryClient = useQueryClient();
    const authMode = isAPIKeyAuth ? 'apikey' : 'user'; // authMode 区分两种认证模式各自需要的初始 API。
    const [readyMode, setReadyMode] = useState<string | null>(null); // readyMode 记录已完成初始请求的认证模式。
    const [initAttempt, setInitAttempt] = useState(0); // initAttempt 变化时重跑初始请求。
    const [initTimedOut, setInitTimedOut] = useState(false);
    const currentPage = useAppStore((state) => state.currentPage);
    // visibleItem 延迟提交页面切换，等待 lazy 模块在 Suspense 中准备完成。
    const visibleItem = useDeferredValue(currentPage);
    // 认证模式与已完成的模式不一致时仍需等待，避免退出登录后残留的完成标记让应用提前渲染。
    const apiReady = readyMode === authMode;

    useServiceWorkerUpdate();

    // 初始请求迟迟不返回时给出可操作的提示，避免停留在首屏加载动画上。
    useEffect(() => {
        if (apiReady || authLoading || !isAuthenticated) return;

        const timer = window.setTimeout(() => setInitTimedOut(true), INIT_TIMEOUT_MS);

        return () => window.clearTimeout(timer);
    }, [apiReady, authLoading, initAttempt, isAuthenticated]);

    const retryInit = () => {
        // 先取消仍在飞的初始请求：fetchQuery 会复用同一个未决 promise, 不取消则重试等于没重试。
        void queryClient.cancelQueries();
        setInitTimedOut(false);
        setInitAttempt((attempt) => attempt + 1);
    };

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;

        let cancelled = false;

        const requests = isAPIKeyAuth
            ? [
                queryClient.fetchQuery(apiKeyDashboardStatsQueryOptions),
            ]
            : [
                queryClient.fetchQuery(apiKeyListQueryOptions),
                queryClient.fetchQuery(channelStatsQueryOptions),
                queryClient.fetchQuery(groupListQueryOptions),
                queryClient.fetchQuery(modelListQueryOptions),
                queryClient.fetchQuery(statsDailyQueryOptions),
                queryClient.fetchQuery(statsHourlyQueryOptions),
                queryClient.fetchQuery(statsTotalQueryOptions),
            ];

        void Promise.all(requests).then(() => {
            if (!cancelled) setReadyMode(authMode);
        }, (error: unknown) => {
            // 重试时的主动取消不算请求失败, 由重试后的那轮重新发起请求。
            if (cancelled || isCancelledError(error)) return;
            // 初始请求失败后仍进入应用，由各查询页面展示具体错误状态。
            setReadyMode(authMode);
        });

        return () => {
            cancelled = true;
            setReadyMode(null);
        };
    }, [authMode, authLoading, initAttempt, isAPIKeyAuth, isAuthenticated, queryClient]);

    if (authLoading) return null;

    // 登录页面
    if (!isAuthenticated) {
        return (
            <InitialLoadingGate>
                <LoginForm />
            </InitialLoadingGate>
        );
    }

    // 初始请求超时：让用户选择重试或先进入应用，各页面自行展示错误状态。
    if (!apiReady) {
        if (!initTimedOut) return null;

        return (
            <InitialLoadingGate>
                <div className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center" role="alert">
                    <div className="space-y-2">
                        <p className="text-sm font-medium">{t('initTimeoutTitle')}</p>
                        <p className="text-sm text-muted-foreground">{t('initTimeoutDescription')}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                            onClick={retryInit}
                        >
                            {t('retry')}
                        </button>
                        <button
                            type="button"
                            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
                            onClick={() => setReadyMode(authMode)}
                        >
                            {t('enterAnyway')}
                        </button>
                    </div>
                </div>
            </InitialLoadingGate>
        );
    }

    // API Key 认证模式 - 显示 API Key Dashboard
    if (isAPIKeyAuth) {
        return (
            <InitialLoadingGate>
                <ErrorBoundary>
                    <APIKeyDashboard />
                </ErrorBoundary>
            </InitialLoadingGate>
        );
    }

    // 普通用户应用
    return (
        <AppShell
            actions={
                <ErrorBoundary>
                    <Suspense fallback={<ActionFallback />}>
                        {visibleItem === 'home' && <HomeActions />}
                        {visibleItem === 'channel' && <ChannelActions />}
                        {visibleItem === 'group' && <GroupActions />}
                        {visibleItem === 'model' && <ModelActions />}
                    </Suspense>
                </ErrorBoundary>
            }
        >
            <ErrorBoundary key={visibleItem}>
                <Suspense fallback={<PageFallback />}>
                    <InitialLoadingGate>
                        <AnimatePresence mode="sync">
                        <motion.div
                            key={visibleItem}
                            // 切页只做短淡入: 缩放淡入会更慢, 频繁切页时像卡顿。
                            initial={{ opacity: 0 }}
                            animate={{
                                opacity: 1,
                                transition: {
                                    duration: prefersReducedMotion ? 0 : 0.15,
                                },
                            }}
                            exit={{
                                opacity: 0,
                                transition: { duration: prefersReducedMotion ? 0 : 0.15 },
                            }}
                            className="absolute inset-0 min-h-0 overflow-hidden"
                        >
                            {visibleItem === 'home' && <Home />}
                            {visibleItem === 'channel' && <Channel />}
                            {visibleItem === 'group' && <Group />}
                            {visibleItem === 'model' && <Model />}
                            {visibleItem === 'log' && <Log />}
                            {visibleItem === 'setting' && <Setting />}
                        </motion.div>
                    </AnimatePresence>
                    </InitialLoadingGate>
                </Suspense>
            </ErrorBoundary>
        </AppShell>
    );
}

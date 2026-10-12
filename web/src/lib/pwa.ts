import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';

// useServiceWorkerUpdate 在生产环境注册 Service Worker，并在新版本就绪时提示刷新。
export function useServiceWorkerUpdate(): void {
    const t = useTranslations('common');

    useEffect(() => {
        if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

        let cancelled = false;

        void (async () => {
            try {
                const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
                if (cancelled) return;

                registration.addEventListener('updatefound', () => {
                    const installing = registration.installing;
                    if (!installing) return;

                    installing.addEventListener('statechange', () => {
                        // 已有页面在运行时才提示刷新，首次安装无需打扰。
                        if (installing.state !== 'installed' || !navigator.serviceWorker.controller) return;

                        toast.info(t('updateReady'), {
                            id: 'service-worker-update',
                            duration: Infinity,
                            action: {
                                label: t('reload'),
                                onClick: () => window.location.reload(),
                            },
                        });
                    });
                });
            } catch (error) {
                console.error('Service Worker registration failed', error);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [t]);
}

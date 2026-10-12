// clearAppCache 清理当前应用目录作用域的 Service Worker 注册与缓存。
export async function clearAppCache(): Promise<void> {
    const scope = new URL('./', document.baseURI); // 当前应用的 Service Worker 作用域及缓存所属目录。

    if ('caches' in window) {
        const names = await caches.keys();
        const prefix = `octopus-${encodeURIComponent(scope.pathname)}-`;
        await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) => caches.delete(name)));
    }

    if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration(scope.href);
        if (registration && registration.scope === scope.href) await registration.unregister();
    }
}

// clearAppCacheAndReload 清理缓存后重新加载页面。
export async function clearAppCacheAndReload(): Promise<void> {
    await clearAppCache();
    window.location.reload();
}

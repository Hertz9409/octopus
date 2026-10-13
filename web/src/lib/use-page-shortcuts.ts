import { useEffect } from 'react';
import { useAppStore, type Page } from '@/stores/app';
import { isTypingTarget, requestFocusSearch } from './shortcuts';

// 连续按 g 加字母跳页, 与多数终端工具的习惯一致。
const PAGE_KEYS: Record<string, Page> = {
    h: 'home',
    c: 'channel',
    g: 'group',
    l: 'log',
    s: 'setting',
};

const SEQUENCE_TIMEOUT_MS = 1200;

// usePageShortcuts 注册全局快捷键: g+字母跳页, / 聚焦搜索。
export function usePageShortcuts() {
    const setCurrentPage = useAppStore((state) => state.setCurrentPage);

    useEffect(() => {
        let pendingG = false;
        let timer = 0;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (isTypingTarget(event.target)) {
                pendingG = false;
                return;
            }

            if (pendingG) {
                pendingG = false;
                window.clearTimeout(timer);
                const page = PAGE_KEYS[event.key.toLowerCase()];
                if (page) {
                    event.preventDefault();
                    setCurrentPage(page);
                }
                return;
            }

            if (event.key === 'g') {
                pendingG = true;
                timer = window.setTimeout(() => {
                    pendingG = false;
                }, SEQUENCE_TIMEOUT_MS);
                return;
            }

            if (event.key === '/') {
                event.preventDefault();
                requestFocusSearch();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [setCurrentPage]);
}

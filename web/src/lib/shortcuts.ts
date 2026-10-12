// 全局键盘快捷键共用的工具与事件名。
// 搜索框只在工具栏展开后才存在, 所以快捷键通过事件请求它展开并聚焦。

export const FOCUS_SEARCH_EVENT = 'octopus:focus-search';

export function requestFocusSearch() {
    window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));
}

// 输入类控件获得焦点时不接管按键, 避免打断打字。
export function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    const tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

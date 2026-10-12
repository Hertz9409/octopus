import { useSettingStore, type Locale } from '@/stores/setting';

import zh_hansMessages from '@/locales/zh_hans.json';
import zh_hantMessages from '@/locales/zh_hant.json';
import enMessages from '@/locales/en.json';

// localeMessages 与 languageTags 是 IntlProvider 与请求层共用的语言资源。
export const localeMessages: Record<Locale, typeof zh_hansMessages> = {
    zh_hans: zh_hansMessages,
    zh_hant: zh_hantMessages,
    en: enMessages,
};

export const languageTags: Record<Locale, string> = {
    zh_hans: 'zh-Hans',
    zh_hant: 'zh-Hant',
    en: 'en',
};

// lookupMessage 按点分路径取纯文本文案；只支持字符串，不处理 ICU 变量。
function lookupMessage(locale: Locale, key: string): string | undefined {
    let node: unknown = localeMessages[locale];
    for (const part of key.split('.')) {
        if (typeof node !== 'object' || node === null) return undefined;
        node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : undefined;
}

// translate 供 React 组件之外（请求层等）按当前语言取文案，取不到时回退为键名。
export function translate(key: string): string {
    return lookupMessage(useSettingStore.getState().locale, key) ?? key;
}

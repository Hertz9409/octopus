import { useEffect, type ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { useSettingStore } from '@/stores/setting';
import { languageTags, localeMessages } from '@/lib/i18n';

export function LocaleProvider({ children }: { children: ReactNode }) {
    const locale = useSettingStore((state) => state.locale);

    useEffect(() => {
        document.documentElement.lang = languageTags[locale];
    }, [locale]);

    return (
        <IntlProvider
            locale={languageTags[locale]}
            messages={localeMessages[locale]}
            timeZone="Asia/Shanghai"
        >
            {children}
        </IntlProvider>
    );
}

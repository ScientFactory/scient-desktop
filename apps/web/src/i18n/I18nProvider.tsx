import { GTProvider } from "gt-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { getI18nSnapshot, requestGTLocale, subscribeI18n } from "./runtime";

const requestLocale = (state: { readonly locale: string }) => requestGTLocale(state.locale);

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const { locale, translations } = useSyncExternalStore(subscribeI18n, getI18nSnapshot);
  return (
    <GTProvider locale={locale} translations={translations} _reload={requestLocale}>
      {children}
    </GTProvider>
  );
}

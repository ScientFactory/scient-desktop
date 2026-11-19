import "@fontsource-variable/inter";
import "./share.css";

import { SCIENT_CLOUD_ORIGIN, SCIENT_SHARE_CONTENT_ORIGIN } from "@scientfactory/scient-cloud/api";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "~/i18n/I18nProvider";
import { setI18nLanguage, startI18n } from "~/i18n/runtime";

import { SharePage } from "./SharePage";
import { readShareAddress } from "./shareReader";

/**
 * Entry for the public share page on `scientfactory.com/s/<id>`. It loads no app shell, settings or
 * connections, and the link's key stays in this page: it is read from the fragment only.
 */

const HOSTED_APP_ORIGIN = "https://app.scientfactory.com";

function meta(name: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;
}

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyAppearance = () => document.documentElement.classList.toggle("dark", dark.matches);
applyAppearance();
dark.addEventListener("change", applyAppearance);

const address = readShareAddress(window.location.pathname, window.location.hash);
const root = document.getElementById("root");
if (root !== null) {
  startI18n();
  const applyBrowserLanguage = () => void setI18nLanguage();
  window.addEventListener("languagechange", applyBrowserLanguage);
  void setI18nLanguage().then(() => {
    createRoot(root).render(
      <StrictMode>
        <I18nProvider>
          <SharePage
            address={address}
            apiOrigin={meta("scient-cloud-api") ?? SCIENT_CLOUD_ORIGIN}
            contentOrigin={meta("scient-share-content") ?? SCIENT_SHARE_CONTENT_ORIGIN}
            signInHref={
              address
                ? `${meta("scient-hosted-app") ?? HOSTED_APP_ORIGIN}/shared/${address.shareId}${window.location.hash}`
                : undefined
            }
          />
        </I18nProvider>
      </StrictMode>,
    );
  });
}

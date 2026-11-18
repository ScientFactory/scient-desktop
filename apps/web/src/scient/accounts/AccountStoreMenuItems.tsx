import { msg, T } from "gt-react";
import type { AccountSummary } from "@t3tools/contracts";
import { MenuItem } from "~/components/ui/menu";
import { readLocalApi } from "~/localApi";
import { isMacPlatform } from "~/lib/utils";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";

export function AccountStoreMenuItems({ account }: { account: AccountSummary }) {
  if (!window.desktopBridge) return null;
  const sources = Object.values(account.secrets).map((secret) => secret.source.type);
  const open = async (url: string) => {
    try {
      await readLocalApi()?.shell.openExternal(url);
    } catch {
      toastManager.add({ type: "error", title: m(msg("Could not open the password store")) });
    }
  };
  return (
    <>
      {sources.includes("1password") ? (
        <MenuItem onClick={() => void open("onepassword://")}>
          <T>Open in 1Password</T>
        </MenuItem>
      ) : null}
      {sources.includes("keychain") && isMacPlatform(navigator.platform) ? (
        <MenuItem onClick={() => void open("scient-accounts://keychain")}>
          <T>Open Keychain Access</T>
        </MenuItem>
      ) : null}
    </>
  );
}

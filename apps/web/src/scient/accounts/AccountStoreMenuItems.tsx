import type { AccountSummary } from "@t3tools/contracts";
import { MenuItem } from "~/components/ui/menu";
import { readLocalApi } from "~/localApi";
import { isMacPlatform } from "~/lib/utils";
import { toastManager } from "~/components/ui/toast";

export function AccountStoreMenuItems({ account }: { account: AccountSummary }) {
  if (!window.desktopBridge) return null;
  const sources = Object.values(account.secrets).map((secret) => secret.source.type);
  const open = async (url: string) => {
    try {
      await readLocalApi()?.shell.openExternal(url);
    } catch {
      toastManager.add({ type: "error", title: "Could not open the password store" });
    }
  };
  return (
    <>
      {sources.includes("1password") ? (
        <MenuItem onClick={() => void open("onepassword://")}>Open in 1Password</MenuItem>
      ) : null}
      {sources.includes("keychain") && isMacPlatform(navigator.platform) ? (
        <MenuItem onClick={() => void open("scient-accounts://keychain")}>
          Open Keychain Access
        </MenuItem>
      ) : null}
    </>
  );
}

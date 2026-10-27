import { shell } from "electron";

export function openAccountStore(
  rawUrl: unknown,
  platform: NodeJS.Platform,
): Promise<boolean> | undefined {
  if (rawUrl === "onepassword://")
    return shell.openExternal(rawUrl).then(
      () => true,
      () => false,
    );
  if (rawUrl !== "scient-accounts://keychain") return undefined;
  if (platform !== "darwin") return Promise.resolve(false);
  return openKeychain();
}

async function openKeychain() {
  for (const path of [
    "/System/Library/CoreServices/Applications/Keychain Access.app",
    "/Applications/Utilities/Keychain Access.app",
    "/System/Applications/Passwords.app",
  ]) {
    if (
      await shell.openPath(path).then(
        (error) => error === "",
        () => false,
      )
    )
      return true;
  }
  return false;
}

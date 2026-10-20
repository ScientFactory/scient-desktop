import { useRouter } from "@tanstack/react-router";
import type { SettingsPath } from "./settingsSearch";

/** Warm only the intended destination; navigation owns any visible load error. */
export function useSettingsIntentPreload() {
  const router = useRouter();
  return (to: SettingsPath | "/settings", hash = "") => {
    void router.preloadRoute({ to, hash }).catch(() => undefined);
  };
}

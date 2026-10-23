import { keepAwakeThreadKey } from "@t3tools/contracts";
import { cachedKeepAwakeState, requestKeepAwake } from "./state";
import type { KeepAwakeMenuState } from "./menu";

interface MenuThread {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
}
export function keepAwakeSidebarState(thread: MenuThread): KeepAwakeMenuState | undefined {
  if (!window.desktopBridge?.keepAwake) return undefined;
  const state = cachedKeepAwakeState();
  const record = state?.threads.find(
    (entry) => entry.key === keepAwakeThreadKey(thread.environmentId, thread.id),
  );
  return {
    choice: record?.once ? "once" : "app",
    status: state?.error ? "unknown" : record?.status,
    available: state !== null,
  };
}
export async function handleKeepAwakeAction(action: string, thread: MenuThread) {
  if (action !== "keep-awake:app" && action !== "keep-awake:once") return false;
  await requestKeepAwake({
    type: "choose",
    key: keepAwakeThreadKey(thread.environmentId, thread.id),
    title: thread.title,
    choice: action === "keep-awake:once" ? "once" : "app",
  });
  return true;
}

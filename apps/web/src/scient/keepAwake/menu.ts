import type { ContextMenuItem, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readPrimaryEnvironmentId } from "../../state/environments";

export type KeepAwakeMenuId = "keep-awake";

interface MenuThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}

export function keepAwakeMenu(chosen: boolean | undefined): ContextMenuItem<KeepAwakeMenuId>[] {
  return chosen === undefined
    ? []
    : [{ id: "keep-awake", label: "Keep computer awake until done", checked: chosen }];
}

/**
 * Whether the thread is on "until done". Undefined when the choice would do nothing: the app
 * setting already covers the thread, or it runs on another computer, which this sleep can't pause.
 */
export async function readKeepAwakeChosen(thread: MenuThread) {
  const keepAwake = window.desktopBridge?.keepAwake;
  if (keepAwake === undefined || thread.environmentId !== readPrimaryEnvironmentId()) {
    return undefined;
  }
  const state = await keepAwake().catch(() => null);
  return state === null || state.appSetting ? undefined : state.threads.includes(thread.id);
}

export async function handleKeepAwakeMenuAction(
  action: string,
  thread: MenuThread,
  chosen: boolean | undefined,
) {
  if (action !== "keep-awake") return false;
  await window.desktopBridge?.keepAwake?.({ threadId: thread.id, enabled: !chosen });
  return true;
}

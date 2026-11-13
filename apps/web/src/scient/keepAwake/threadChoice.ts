import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { primaryServerSettingsAtom } from "../../state/server";

interface MenuThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}

/**
 * Whether the thread is on "until done". Undefined when the choice would do nothing: "Keep awake
 * while agents work" already covers the thread, or it runs on another computer, which this sleep
 * can't pause.
 */
export async function readKeepAwakeChosen(thread: MenuThread) {
  const keepAwake = window.desktopBridge?.keepAwake;
  if (
    keepAwake === undefined ||
    thread.environmentId !== readPrimaryEnvironmentId() ||
    appAtomRegistry.get(primaryServerSettingsAtom).keepAwakeWhileAgentsWork
  ) {
    return undefined;
  }
  const state = await keepAwake().catch(() => null);
  return state === null ? undefined : state.threads.includes(thread.id);
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

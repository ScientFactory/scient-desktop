// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the relaunch watcher outlives this process; the marker is written synchronously while quitting; the grant poll runs only while it watches.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { MAC_PERMISSION_SETTINGS_URLS } from "../../permissions/MacPermission.ts";
import { runningWorkCount, whenRunningWorkIdle } from "../quitGuard/ipc.ts";

/** The macOS privacy panes an agent's computer control needs; macOS charges them to Scient. */
export type ComputerControlPermission = "screen-recording" | "accessibility";

export const isComputerControlPermission = (pane: string): pane is ComputerControlPermission =>
  pane === "screen-recording" || pane === "accessibility";

export const computerControlPermissionGranted = (permission: ComputerControlPermission): boolean =>
  permission === "screen-recording"
    ? Electron.systemPreferences.getMediaAccessStatus("screen") === "granted"
    : Electron.systemPreferences.isTrustedAccessibilityClient(false);

/**
 * Asking is what lists Scient in the pane, in the right list (macOS 15+ splits the pane into
 * screen and audio-only lists), so the user only has to turn it on. macOS shows its own prompt
 * the first time and answers silently after that. Electron reports screen access only as
 * granted or denied, so it asks whenever access is missing.
 */
async function requestComputerControlPermission(
  permission: ComputerControlPermission,
): Promise<void> {
  if (computerControlPermissionGranted(permission)) return;
  if (permission === "accessibility") {
    Electron.systemPreferences.isTrustedAccessibilityClient(true);
    return;
  }
  await Electron.desktopCapturer
    .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
    .catch(() => undefined);
}

/**
 * Turning on Screen Recording can end a running Scient (seen on macOS 26.7: ended without a
 * clean quit at the moment of the grant), which would stop runs that are going. With runs
 * going, Scient waits for them to finish before it opens the pane.
 */
function confirmOpenWhenRunsFinish(running: number): boolean {
  const choice = Electron.dialog.showMessageBoxSync({
    type: "info",
    message: "Allow Screen Recording when your runs finish?",
    detail: `macOS may close Scient when you turn on Screen Recording, which would stop ${running === 1 ? "the run that is" : `the ${running} runs that are`} going. Scient opens System Settings as soon as ${running === 1 ? "it finishes" : "they finish"}.`,
    buttons: ["Open when they finish", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  return choice === 0;
}

/** macOS ends the app at the moment of the grant, so the watcher outlives a seen grant briefly. */
const GRANTED_GRACE_MS = 30_000;
const GRANT_POLL_MS = 2_000;
let relaunchWatching = false;
let cleanExitMarker: string | undefined;

/**
 * Until Screen Recording is on, a detached watcher reopens Scient if it is ended without a clean
 * quit. A clean quit (macOS's own Quit & Reopen, or the user's) ends the watch, and so does a grant
 * seen in this process.
 */
function watchForForcedExit(): void {
  if (!Electron.app.isPackaged || relaunchWatching) return;
  const bundle = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/u.exec(process.execPath)?.[1];
  if (!bundle) return;
  relaunchWatching = true;
  if (cleanExitMarker === undefined) {
    const marker = NodePath.join(Electron.app.getPath("temp"), `scient-clean-exit-${process.pid}`);
    cleanExitMarker = marker;
    Electron.app.once("will-quit", () => {
      try {
        NodeFS.writeFileSync(marker, "");
      } catch {}
    });
  }
  const script = [
    'while kill -0 "$1" 2>/dev/null; do sleep 1; done',
    'if [ -e "$2" ]; then rm -f "$2"; exit 0; fi',
    'sleep 1; exec /usr/bin/open "$3"',
  ].join("\n");
  const watcher = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", script, "scient-relaunch-watch", String(process.pid), cleanExitMarker, bundle],
    { detached: true, stdio: "ignore" },
  );
  const poll = setInterval(() => {
    if (!computerControlPermissionGranted("screen-recording")) return;
    clearInterval(poll);
    setTimeout(() => watcher.kill(), GRANTED_GRACE_MS).unref();
  }, GRANT_POLL_MS);
  poll.unref();
  const stopped = () => {
    clearInterval(poll);
    relaunchWatching = false;
  };
  watcher.once("exit", stopped);
  watcher.once("error", stopped);
  watcher.unref();
}

async function openPane(permission: ComputerControlPermission): Promise<boolean> {
  if (permission === "screen-recording" && !computerControlPermissionGranted(permission))
    watchForForcedExit();
  await requestComputerControlPermission(permission);
  return Electron.shell.openExternal(MAC_PERMISSION_SETTINGS_URLS[permission]).then(
    () => true,
    () => false,
  );
}

/**
 * Asks macOS (which lists Scient in the pane) and opens the pane, or, for Screen Recording
 * while runs are going, opens it once they finish.
 */
export async function openComputerControlPermissionPane(
  permission: ComputerControlPermission,
): Promise<"opened" | "deferred" | "cancelled" | "failed"> {
  const running = runningWorkCount();
  if (
    permission === "screen-recording" &&
    running > 0 &&
    !computerControlPermissionGranted(permission)
  ) {
    if (!confirmOpenWhenRunsFinish(running)) return "cancelled";
    whenRunningWorkIdle(() => void openPane(permission));
    return "deferred";
  }
  return (await openPane(permission)) ? "opened" : "failed";
}

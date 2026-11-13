// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Plain async Electron work; the fresh check is a short-lived osascript child.
import * as NodeChildProcess from "node:child_process";

import * as Electron from "electron";

import { MAC_PERMISSION_SETTINGS_URLS } from "../../permissions/MacPermission.ts";

/** The macOS privacy panes an agent's computer control needs; macOS charges them to Scient. */
export type ComputerControlPermission = "screen-recording" | "accessibility";

export const isComputerControlPermission = (pane: string): pane is ComputerControlPermission =>
  pane === "screen-recording" || pane === "accessibility";

const inProcessGranted = (permission: ComputerControlPermission): boolean =>
  permission === "screen-recording"
    ? Electron.systemPreferences.getMediaAccessStatus("screen") === "granted"
    : Electron.systemPreferences.isTrustedAccessibilityClient(false);

/**
 * macOS keeps a process's first Screen Recording answer until it exits, so a grant made with
 * "Later" never reaches this process. A new process asks afresh and is charged to Scient; these
 * preflight calls never prompt.
 */
const FRESH_CHECK = [
  'ObjC.import("CoreGraphics");',
  'ObjC.import("ApplicationServices");',
  'ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);',
  'ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]);',
  '[$.CGPreflightScreenCaptureAccess(), $.AXIsProcessTrusted()].map(Number).join(" ")',
].join("");
/** Asks for Screen Recording the official way, which lists Scient in the top list and prompts once. */
const SCREEN_REQUEST = [
  'ObjC.import("CoreGraphics");',
  'ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]);',
  "$.CGRequestScreenCaptureAccess()",
].join("");
const HELPER_TIMEOUT_MS = 3_000;
/** The status row polls; a refusal is reused this long so it starts at most one child per interval. */
const RECHECK_AFTER_MS = 2_000;

type Grants = Record<ComputerControlPermission, boolean>;

const seenGranted = new Set<ComputerControlPermission>();
/** A check still running is shared; a finished one is reused until `RECHECK_AFTER_MS` passes. */
let freshCheck: { readonly grants: Promise<Grants>; settledAt?: number } | undefined;

/** Runs `script` in a short-lived child, which macOS charges to Scient; its output, or "" on failure. */
const runHelper = (script: string): Promise<string> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: HELPER_TIMEOUT_MS },
      (error, stdout) => resolve(error ? "" : stdout.trim()),
    );
  });

const runFreshCheck = (): Promise<Grants> =>
  runHelper(FRESH_CHECK).then((output) => {
    const [screen, accessibility] = output.split(" ");
    return { "screen-recording": screen === "1", accessibility: accessibility === "1" };
  });

/** Whether macOS lets Scient use `permission` now, including a grant made since Scient started. */
export async function computerControlPermissionGranted(
  permission: ComputerControlPermission,
): Promise<boolean> {
  if (seenGranted.has(permission) || inProcessGranted(permission)) return true;
  const settledAt = freshCheck?.settledAt;
  if (!freshCheck || (settledAt !== undefined && Date.now() - settledAt >= RECHECK_AFTER_MS)) {
    const check: { grants: Promise<Grants>; settledAt?: number } = { grants: runFreshCheck() };
    void check.grants.then((grants) => {
      check.settledAt = Date.now();
      if (grants["screen-recording"]) seenGranted.add("screen-recording");
      if (grants.accessibility) seenGranted.add("accessibility");
    });
    freshCheck = check;
  }
  await freshCheck.grants;
  return seenGranted.has(permission);
}

/**
 * Asking is what lists Scient in the pane, in the right list (macOS 15+ splits the pane into
 * screen and audio-only lists), so the user only has to turn it on. macOS shows its own prompt
 * the first time and answers silently after that. Electron's screen capture request does not
 * list the app (seen on macOS 26.7), so Screen Recording is requested from a helper.
 */
async function requestComputerControlPermission(
  permission: ComputerControlPermission,
): Promise<void> {
  if (await computerControlPermissionGranted(permission)) return;
  if (permission === "accessibility") {
    Electron.systemPreferences.isTrustedAccessibilityClient(true);
    return;
  }
  await runHelper(SCREEN_REQUEST);
}

/** Asks macOS, which lists Scient in the pane, then opens the pane. */
export async function openComputerControlPermissionPane(
  permission: ComputerControlPermission,
): Promise<boolean> {
  await requestComputerControlPermission(permission);
  return Electron.shell.openExternal(MAC_PERMISSION_SETTINGS_URLS[permission]).then(
    () => true,
    () => false,
  );
}

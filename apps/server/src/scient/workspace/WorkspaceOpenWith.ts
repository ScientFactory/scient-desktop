// @effect-diagnostics nodeBuiltinImport:off
/**
 * Open With for a project entry: the apps the computer itself offers, as Finder
 * lists them (macOS), or the computer's own chooser (Windows' "Open with"
 * window). Linux has no chooser shared by its desktops, so it offers none.
 */
import * as NodeChildProcess from "node:child_process";

import {
  type WorkspaceOpenWithApps,
  WorkspaceOpenWithError,
  type WorkspaceOpenWithInput,
  type WorkspaceOpenWithTarget,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import type { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";

type ResolveEntryPath = WorkspaceFileSystem["Service"]["resolveEntryPath"];

const MAC_APPS_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  const files = $.NSFileManager.defaultManager;
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const preferred = workspace.URLForApplicationToOpenURL(url);
  const preferredPath = preferred.isNil() ? "" : ObjC.unwrap(preferred.path);
  const apps = workspace.URLsForApplicationsToOpenURL(url);
  const out = [];
  for (let index = 0; index < apps.count; index++) {
    const path = ObjC.unwrap(apps.objectAtIndex(index).path);
    out.push({ id: path, name: ObjC.unwrap(files.displayNameAtPath(path)), isDefault: path === preferredPath });
  }
  return JSON.stringify(out);
}`;

function execFile(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    );
  });
}

/** Starts an app without waiting for it, as double-clicking does. */
function launch(command: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function macApps(absolutePath: string): Promise<WorkspaceOpenWithApps["apps"]> {
  const output = await execFile("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    MAC_APPS_SCRIPT,
    absolutePath,
  ]);
  const parsed = JSON.parse(output.trim() || "[]") as Array<{
    id: string;
    name: string;
    isDefault: boolean;
  }>;
  // The default first, then by name; one entry per name (an app can be installed twice).
  const seen = new Set<string>();
  return parsed
    .filter((app) => app.id.trim() && app.name.trim())
    .toSorted((left, right) =>
      left.isDefault === right.isDefault
        ? left.name.localeCompare(right.name)
        : left.isDefault
          ? -1
          : 1,
    )
    .filter((app) => (seen.has(app.name) ? false : (seen.add(app.name), true)))
    .map((app) => ({
      id: app.id,
      name: app.name.replace(/\.app$/u, ""),
      isDefault: app.isDefault,
    }));
}

const failure = (message: string) => new WorkspaceOpenWithError({ message });

const resolveTarget = (resolveEntryPath: ResolveEntryPath, input: WorkspaceOpenWithTarget) =>
  resolveEntryPath(input).pipe(
    Effect.mapError(() => failure(`Scient can't open ${input.relativePath} with another app.`)),
  );

export const listOpenWithApps = Effect.fn("WorkspaceOpenWith.list")(function* (
  resolveEntryPath: ResolveEntryPath,
  input: WorkspaceOpenWithTarget,
) {
  const platform = yield* HostProcess.Platform;
  const target = yield* resolveTarget(resolveEntryPath, input);
  if (platform === "win32") return { apps: [], chooser: true } satisfies WorkspaceOpenWithApps;
  if (platform !== "darwin") return { apps: [], chooser: false } satisfies WorkspaceOpenWithApps;
  const apps = yield* Effect.tryPromise({
    try: () => macApps(target.absolutePath),
    catch: (cause) => failure(cause instanceof Error ? cause.message : "Couldn't list the apps."),
  });
  return { apps, chooser: false } satisfies WorkspaceOpenWithApps;
});

export const openWith = Effect.fn("WorkspaceOpenWith.open")(function* (
  resolveEntryPath: ResolveEntryPath,
  input: WorkspaceOpenWithInput,
) {
  const platform = yield* HostProcess.Platform;
  const target = yield* resolveTarget(resolveEntryPath, input);
  const run = (command: string, args: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () => launch(command, args),
      catch: (cause) => failure(cause instanceof Error ? cause.message : "Couldn't open the app."),
    });
  if (input.app._tag === "chooser") {
    if (platform !== "win32") return yield* failure("This computer has no app chooser.");
    yield* run("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", target.absolutePath]);
    return {};
  }
  if (platform !== "darwin") return yield* failure("Open With lists apps only on macOS.");
  // Only an app the computer itself offers for this entry, never any program by path.
  const appId = input.app.id;
  const offered = yield* Effect.tryPromise({
    try: () => macApps(target.absolutePath),
    catch: (cause) => failure(cause instanceof Error ? cause.message : "Couldn't list the apps."),
  });
  if (!offered.some((app) => app.id === appId)) {
    return yield* failure("That app no longer offers to open this item.");
  }
  yield* run("/usr/bin/open", ["-a", appId, target.absolutePath]);
  return {};
});

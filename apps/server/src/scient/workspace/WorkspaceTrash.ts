// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Moves items to the computer's own Trash: Foundation's trashItem on macOS (it reports
 * where each went), the freedesktop.org Trash on Linux, and the Recycle Bin on Windows,
 * which does not say where items went, so only Explorer can restore them.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface TrashHost {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly userId: number | undefined;
}

export type TrashOutcome =
  | {
      readonly ok: true;
      /** Where the item is now, when the platform says; needed to put it back. */
      readonly trashedPath?: string;
      /** A record to remove when the item is put back (freedesktop's `.trashinfo`). */
      readonly infoPath?: string;
    }
  | { readonly ok: false; readonly message: string };

const TRASH_TIMEOUT_MS = 60_000;

/** One outcome per path, in order. Paths are absolute and already checked. */
export async function moveToTrash(
  host: TrashHost,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<TrashOutcome>> {
  if (paths.length === 0) return [];
  if (host.platform === "darwin") return trashOnMac(paths);
  if (host.platform === "win32") return trashOnWindows(paths);
  const outcomes: TrashOutcome[] = [];
  for (const path of paths) outcomes.push(await trashFreedesktop(host, path));
  return outcomes;
}

/** Whether Scient can put back what it moved to this platform's Trash. */
export const trashCanRestore = (platform: NodeJS.Platform) => platform !== "win32";

/** The Trash's name where people see it. */
export const trashName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "the Recycle Bin" : "the Trash";

function run(command: string, args: ReadonlyArray<string>, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: TRASH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input ?? "");
  });
}

function parseOutcomes(output: string, count: number): ReadonlyArray<TrashOutcome> {
  const parsed: unknown = JSON.parse(output.trim() || "[]");
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return Array.from({ length: count }, (_, index): TrashOutcome => {
    const entry = list[index] as
      | { ok?: unknown; trashedPath?: unknown; message?: unknown }
      | undefined;
    if (entry?.ok === true) {
      return typeof entry.trashedPath === "string" && entry.trashedPath.length > 0
        ? { ok: true, trashedPath: entry.trashedPath }
        : { ok: true };
    }
    return {
      ok: false,
      message: typeof entry?.message === "string" ? entry.message : "Moving to the Trash failed.",
    };
  });
}

const MAC_TRASH_SCRIPT = `
ObjC.import("Foundation");
function run(paths) {
  const manager = $.NSFileManager.defaultManager;
  return JSON.stringify(paths.map((path) => {
    const resulting = $();
    const failure = $();
    const ok = manager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), resulting, failure);
    return ok
      ? { ok: true, trashedPath: ObjC.unwrap(resulting.path) }
      : { ok: false, message: ObjC.unwrap(failure.localizedDescription) };
  }));
}`;

/** osascript takes the paths as arguments; keep each call well under the argument limit. */
const MAC_BATCH = 100;

async function trashOnMac(paths: ReadonlyArray<string>): Promise<ReadonlyArray<TrashOutcome>> {
  const outcomes: TrashOutcome[] = [];
  for (let start = 0; start < paths.length; start += MAC_BATCH) {
    const batch = paths.slice(start, start + MAC_BATCH);
    try {
      const output = await run("/usr/bin/osascript", [
        "-l",
        "JavaScript",
        "-e",
        MAC_TRASH_SCRIPT,
        ...batch,
      ]);
      outcomes.push(...parseOutcomes(output, batch.length));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push(...batch.map((): TrashOutcome => ({ ok: false, message })));
    }
  }
  return outcomes;
}

// Paths arrive on stdin as JSON, so no path is ever part of the command line.
const WINDOWS_TRASH_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
$results = foreach ($path in $paths) {
  try {
    if ([System.IO.Directory]::Exists($path)) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
    }
    [pscustomobject]@{ ok = $true }
  } catch {
    [pscustomobject]@{ ok = $false; message = $_.Exception.Message }
  }
}
ConvertTo-Json -InputObject @($results) -Compress
`;

async function trashOnWindows(paths: ReadonlyArray<string>): Promise<ReadonlyArray<TrashOutcome>> {
  try {
    const output = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_TRASH_SCRIPT,
      ],
      JSON.stringify(paths),
    );
    return parseOutcomes(output, paths.length).map((outcome) =>
      // The Recycle Bin does not say where an item went.
      outcome.ok ? { ok: true } : outcome,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return paths.map((): TrashOutcome => ({ ok: false, message }));
  }
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** The folder at the top of `path`'s volume: the last ancestor on the same device. */
async function volumeTop(path: string, device: number): Promise<string> {
  let current = NodePath.dirname(path);
  for (;;) {
    const parent = NodePath.dirname(current);
    if (parent === current) return current;
    if ((await NodeFSP.stat(parent)).dev !== device) return current;
    current = parent;
  }
}

/** The home Trash when the item shares its volume, else that volume's `.Trash-<uid>`. */
async function freedesktopTrashFor(host: TrashHost, path: string): Promise<string> {
  const dataHome = host.environment.XDG_DATA_HOME?.trim()
    ? host.environment.XDG_DATA_HOME
    : NodePath.join(host.homeDirectory, ".local", "share");
  const homeTrash = NodePath.join(dataHome, "Trash");
  const device = (await NodeFSP.lstat(path)).dev;
  let probe = homeTrash;
  for (;;) {
    try {
      if ((await NodeFSP.stat(probe)).dev === device) return homeTrash;
      break;
    } catch (error) {
      if (!isMissing(error) || NodePath.dirname(probe) === probe) throw error;
      probe = NodePath.dirname(probe);
    }
  }
  if (host.userId === undefined) throw new Error("This volume has no Trash Scient can use.");
  return NodePath.join(await volumeTop(path, device), `.Trash-${host.userId}`);
}

const pad = (value: number) => String(value).padStart(2, "0");
const deletionDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

async function trashFreedesktop(host: TrashHost, path: string): Promise<TrashOutcome> {
  try {
    const trash = await freedesktopTrashFor(host, path);
    const filesDirectory = NodePath.join(trash, "files");
    const infoDirectory = NodePath.join(trash, "info");
    await NodeFSP.mkdir(filesDirectory, { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(infoDirectory, { recursive: true, mode: 0o700 });
    const info = [
      "[Trash Info]",
      `Path=${path.split("/").map(encodeURIComponent).join("/")}`,
      `DeletionDate=${deletionDate(new Date())}`,
      "",
    ].join("\n");
    const { name, extension } = splitName(NodePath.basename(path), false);
    for (let attempt = 1; attempt < 10_000; attempt++) {
      const leaf = attempt === 1 ? `${name}${extension}` : `${name} ${attempt}${extension}`;
      const infoPath = NodePath.join(infoDirectory, `${leaf}.trashinfo`);
      try {
        // Claiming the info file first reserves the name, as the spec asks.
        await NodeFSP.writeFile(infoPath, info, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const trashedPath = NodePath.join(filesDirectory, leaf);
      try {
        await NodeFSP.rename(path, trashedPath);
      } catch (error) {
        await NodeFSP.rm(infoPath, { force: true });
        throw error;
      }
      return { ok: true, trashedPath, infoPath };
    }
    throw new Error("The Trash has no free name for this item.");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A name's stem and extension. Folders and names that start with their only
 * dot (".env") have no extension.
 */
export function splitName(
  name: string,
  isDirectory: boolean,
): { readonly name: string; readonly extension: string } {
  const dot = name.lastIndexOf(".");
  if (isDirectory || dot <= 0) return { name, extension: "" };
  return { name: name.slice(0, dot), extension: name.slice(dot) };
}

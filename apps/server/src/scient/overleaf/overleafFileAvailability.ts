// @effect-diagnostics nodeBuiltinImport:off -- Metadata only; never open a placeholder's data.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { windowsNativeFlags } from "../workspace/WindowsNativeFile.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
export type OverleafFileAvailability = "available" | "online-only-file" | "helper-unavailable";

/** Flags of each path, in order: st_flags on macOS; group C supplies Windows attributes. */
export type OverleafFileFlagReader = (
  paths: ReadonlyArray<string>,
) => Promise<ReadonlyArray<number>>;

/** Paths per `stat` run: one run per batch keeps a capture's cost flat, not one per file. */
const STAT_BATCH = 256;

const statFlags = async (paths: ReadonlyArray<string>) => {
  // Node's Stats omits st_flags. BSD stat uses lstat, without reading file contents.
  const { stdout } = await run("/usr/bin/stat", ["-f", "%f", "--", ...paths]);
  const lines = stdout.split("\n").filter((line) => line !== "");
  if (lines.length !== paths.length) throw new Error("stat answered for other paths");
  return lines.map((line) => (/^\d+$/u.test(line) ? Number(line) : NaN));
};

/** A file gone since it was listed reads as available, so its read reports the change. */
const statOne = async (path: string): Promise<number> =>
  statFlags([path]).then(
    ([flags]) => flags ?? NaN,
    async () =>
      (await NodeFSP.lstat(path).then(
        () => true,
        () => false,
      ))
        ? NaN
        : 0,
  );

const macFlags: OverleafFileFlagReader = async (paths) => {
  const flags: number[] = [];
  for (let start = 0; start < paths.length; start += STAT_BATCH) {
    const batch = paths.slice(start, start + STAT_BATCH);
    // A batch fails as a whole when one path vanished; then each path is asked alone.
    flags.push(...(await statFlags(batch).catch(async () => Promise.all(batch.map(statOne)))));
  }
  return flags;
};

const windowsFlags = async (paths: ReadonlyArray<string>, helper?: string) => {
  const flags: number[] = [];
  let batch: string[] = [],
    length = 0;
  for (const path of paths) {
    if (batch.length && (batch.length >= STAT_BATCH || length + path.length > 24_000)) {
      flags.push(...(await windowsNativeFlags(batch, helper)));
      batch = [];
      length = 0;
    }
    batch.push(path);
    length += path.length + 3;
  }
  if (batch.length) flags.push(...(await windowsNativeFlags(batch, helper)));
  return flags;
};

/** Whether each file's bytes are on this disk, decided from metadata alone. */
export async function overleafFilesAvailability(
  paths: ReadonlyArray<string>,
  platform: string = HostProcess.Platform.defaultValue(),
  readFlags?: OverleafFileFlagReader,
  helper?: string,
): Promise<ReadonlyMap<string, OverleafFileAvailability>> {
  const answer = (value: OverleafFileAvailability) => new Map(paths.map((path) => [path, value]));
  if (platform === "linux" || paths.length === 0) return answer("available");
  if (platform !== "darwin" && platform !== "win32") return answer("helper-unavailable");
  const reader =
    readFlags ??
    (platform === "darwin"
      ? macFlags
      : (paths: ReadonlyArray<string>) => windowsFlags(paths, helper));
  if (reader === undefined) return answer("helper-unavailable");
  const flags = await reader(paths).catch(() => null);
  if (flags === null || flags.length !== paths.length) return answer("helper-unavailable");
  // SF_DATALESS, or OFFLINE / RECALL_ON_OPEN / RECALL_ON_DATA_ACCESS.
  const mask = platform === "darwin" ? 0x40000000 : 0x1000 | 0x40000 | 0x400000;
  return new Map(
    paths.map((path, index) => {
      const value = flags[index]!;
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff)
        return [path, "helper-unavailable"] as const;
      return [path, (value & mask) !== 0 ? "online-only-file" : "available"] as const;
    }),
  );
}

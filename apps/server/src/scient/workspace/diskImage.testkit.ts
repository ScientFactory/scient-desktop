// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off -- Promise fixture for plain tests: hdiutil deadlines and a teardown warning.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

const HDIUTIL = "/usr/bin/hdiutil";

/** macOS can create and mount a disk image in a test. */
export const diskImagesAvailable =
  HostProcess.Platform.defaultValue() === "darwin" &&
  NodeChildProcess.spawnSync(HDIUTIL, ["help"], { timeout: 10_000 }).status !== null;

export type DiskImageFormat = "APFS" | "ExFAT" | "HFS+" | "JHFS+" | "MS-DOS FAT32";

interface Run {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

function run(command: string, args: ReadonlyArray<string>, timeout: number): Promise<Run> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      args,
      { timeout: Math.max(1_000, timeout), killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (error === null) return resolve({ code: 0, output, timedOut: false });
        const failure = error as NodeChildProcess.ExecFileException;
        resolve({
          code: typeof failure.code === "number" ? failure.code : null,
          output: output || failure.message,
          timedOut: failure.killed === true && failure.signal === "SIGKILL",
        });
      },
    );
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// hdiutil exits 16 (EBUSY) when diskarbitrationd, fsck or Spotlight still holds the disk.
const busy = (result: Run) => result.code === 16 || /resource busy/i.test(result.output);

const describeRun = (command: string, args: ReadonlyArray<string>, result: Run) =>
  `${command} ${args.join(" ")} ${result.timedOut ? "timed out" : `exited ${result.code}`}: ${result.output}`;

/** Runs hdiutil, retrying while the disk is busy, until `deadline`. */
async function hdiutil(args: ReadonlyArray<string>, deadline: number, attempts: number) {
  let result: Run = { code: null, output: "not run", timedOut: false };
  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt++) {
    if (attempt > 0) await pause(1_000);
    result = await run(HDIUTIL, args, Math.min(30_000, deadline - Date.now()));
    if (result.code === 0 || !busy(result)) break;
  }
  return result;
}

async function stillMounted(point: string) {
  const [inner, outer] = await Promise.all([
    NodeFSP.stat(point).catch(() => null),
    NodeFSP.stat(NodePath.dirname(point)).catch(() => null),
  ]);
  return inner !== null && outer !== null && inner.dev !== outer.dev;
}

export interface DiskImage {
  /** Mounts the image at `point` (a fresh folder by default) and returns the mount's real path. */
  readonly attach: (point?: string) => Promise<string>;
  /** Unmounts it, as an unplugged disk; fails only if the volume is still mounted afterwards. */
  readonly detach: () => Promise<void>;
  /** Unmounts if needed and removes the image; logs instead of failing, the image is disposable. */
  readonly dispose: () => Promise<void>;
}

/**
 * A fresh disk image of `format`. Every hdiutil call is bounded, and a busy disk is retried:
 * the runners' system services sometimes hold a just-created or just-unmounted disk.
 */
export async function createDiskImage(
  format: DiskImageFormat,
  options: { readonly megabytes?: number; readonly volumeName?: string } = {},
): Promise<DiskImage> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-disk-image-")),
  );
  const file = NodePath.join(root, "disk.dmg");
  const createArgs = [
    "create",
    "-ov",
    "-size",
    `${options.megabytes ?? 40}m`,
    "-fs",
    format,
    "-volname",
    options.volumeName ?? "SCTDISK",
    file,
  ];
  const created = await hdiutil(createArgs, Date.now() + 60_000, 5);
  if (created.code !== 0) {
    await NodeFSP.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(describeRun(HDIUTIL, createArgs, created));
  }

  let mounted: { readonly point: string; readonly devices: ReadonlyArray<string> } | null = null;
  let points = 0;

  const unmount = async (deadline: number) => {
    const current = mounted;
    if (current === null) return null;
    let result = await hdiutil(["detach", current.point], deadline - 10_000, 5);
    if (result.code !== 0) result = await hdiutil(["detach", "-force", current.point], deadline, 3);
    if (result.code === 0 || !(await stillMounted(current.point))) {
      mounted = null;
      return result.code === 0 ? null : result;
    }
    return result;
  };

  // System services hold disks as root, so ask sudo first where it needs no password (CI).
  const holders = async (point: string, devices: ReadonlyArray<string>) => {
    const names = new Set(devices.map((device) => NodePath.basename(device)));
    const nodes = (await NodeFSP.readdir("/dev").catch(() => []))
      .filter((entry) => names.has(entry.replace(/^r/, "").replace(/s\d+$/, "")))
      .map((entry) => `/dev/${entry}`);
    const args = ["-n", "-P", ...(nodes.length === 0 ? ["+f", "--", point] : nodes)];
    const elevated = await run("/usr/bin/sudo", ["-n", "/usr/sbin/lsof", ...args], 10_000);
    const listed = elevated.output.startsWith("COMMAND")
      ? elevated
      : await run("/usr/sbin/lsof", args, 10_000);
    return listed.output || "(no holders listed)";
  };

  return {
    attach: async (point) => {
      if (mounted !== null) throw new Error(`Disk image already mounted at ${mounted.point}`);
      const target = point ?? NodePath.join(root, `mount-${++points}`);
      await NodeFSP.mkdir(target, { recursive: true });
      const args = ["attach", "-nobrowse", "-noverify", "-noautofsck", "-mountpoint", target, file];
      const result = await hdiutil(args, Date.now() + 60_000, 5);
      if (result.code !== 0) throw new Error(describeRun(HDIUTIL, args, result));
      mounted = { point: target, devices: [...new Set(result.output.match(/\/dev\/disk\d+/g))] };
      await NodeFSP.writeFile(NodePath.join(target, ".metadata_never_index"), "").catch(
        () => undefined,
      );
      return NodeFSP.realpath(target);
    },
    detach: async () => {
      const current = mounted;
      const failure = await unmount(Date.now() + 40_000);
      if (failure !== null && current !== null && mounted !== null)
        throw new Error(
          `${describeRun(HDIUTIL, ["detach", current.point], failure)}\nHolders:\n${await holders(current.point, current.devices)}`,
        );
    },
    dispose: async () => {
      const current = mounted;
      const failure = await unmount(Date.now() + 40_000);
      if (failure !== null && current !== null) {
        console.warn(
          `Left disk image ${file} ${mounted === null ? "unmounted but not ejected" : "mounted"}: ${describeRun(HDIUTIL, ["detach", current.point], failure)}\nHolders:\n${await holders(current.point, current.devices)}`,
        );
        if (mounted !== null) return;
      }
      await NodeFSP.rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

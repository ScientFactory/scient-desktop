// @effect-diagnostics nodeBuiltinImport:off -- Test support: instruments node:fs/promises to stop a store operation at a chosen file change.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeProcess from "node:process";

/**
 * Stops store code at a chosen file change ("point": every `node:fs/promises` call that changes
 * the disk, in call order, including writes through the handle `open` returns). A killed process,
 * not a power cut: calls that completed stay on disk. Details: docs/internals/scient-sources.md.
 */
export type FileFaultPlan =
  /** Only counts, so a later run can name each point. */
  (
    | { readonly kind: "count" }
    /** SIGKILL before the point; `torn` lets half of a file's contents through first. */
    | { readonly kind: "kill"; readonly at: number; readonly torn?: boolean }
    /** The point fails and the code carries on; `persist`: a full disk from then on. */
    | {
        readonly kind: "error";
        readonly at: number;
        readonly code: "ENOSPC" | "EIO";
        readonly persist?: boolean;
      }
  ) & {
    /** Every hard link fails with EPERM, as on a volume without them. */
    readonly refuseLinks?: boolean;
  };

export interface FileFaultPoint {
  readonly call: string;
  readonly path: string;
}

type Call = (...args: unknown[]) => Promise<unknown>;

/** The node:fs/promises calls the Sources stores use that change the disk. */
const CHANGING_CALLS = [
  "appendFile",
  "chmod",
  "copyFile",
  "cp",
  "link",
  "mkdir",
  "rename",
  "rm",
  "rmdir",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
] as const;

const HANDLE_CHANGING_CALLS = [
  "appendFile",
  "datasync",
  "sync",
  "truncate",
  "write",
  "writeFile",
  "writev",
] as const;

/** Calls that need free disk space; removing, renaming and flushing work on a full disk. */
const NEEDS_SPACE = new Set([
  "appendFile",
  "copyFile",
  "cp",
  "mkdir",
  "open",
  "writeFile",
  "handle.appendFile",
  "handle.write",
  "handle.writeFile",
  "handle.writev",
]);

const originals = new Map<string, Call>();
let plan: FileFaultPlan | null = null;
let seen = 0;
let failing = false;
const trace: FileFaultPoint[] = [];

function die(): never {
  NodeProcess.kill(NodeProcess.pid, "SIGKILL");
  // The signal may arrive a moment later; nothing else may run meanwhile.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
}

function failure(code: string, call: string, path: unknown): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `${code}: simulated failure, ${call} '${String(path)}'`,
  );
  error.code = code;
  error.syscall = call;
  return error;
}

function opensForWriting(flags: unknown): boolean {
  if (typeof flags === "string") return /[wa+]/u.test(flags);
  if (typeof flags !== "number") return false;
  const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = NodeFS.constants;
  return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
}

function half(data: unknown): Buffer | null {
  const bytes =
    typeof data === "string"
      ? Buffer.from(data, "utf8")
      : data instanceof Uint8Array
        ? Buffer.from(data)
        : null;
  return bytes ? bytes.subarray(0, Math.floor(bytes.length / 2)) : null;
}

/**
 * Counts one file change. Returns "torn" when the caller must write half of the contents and
 * then die; dies or throws itself otherwise when the plan stops this call.
 */
function point(call: string, path: unknown): "run" | "torn" {
  if (!plan) return "run";
  if (call === "link" && plan.refuseLinks) throw failure("EPERM", call, path);
  seen += 1;
  trace.push({ call, path: String(path) });
  if (plan.kind === "kill" && plan.at === seen) {
    if (plan.torn) return "torn";
    die();
  }
  if (plan.kind === "error") {
    if (plan.at === seen && !plan.persist) throw failure(plan.code, call, path);
    if (plan.at <= seen && plan.persist) failing = true;
    if (failing && NEEDS_SPACE.has(call)) throw failure(plan.code, call, path);
  }
  return "run";
}

function instrumentHandle(handle: NodeFS.promises.FileHandle, path: unknown): void {
  for (const name of HANDLE_CHANGING_CALLS) {
    const original = handle[name] as unknown as Call;
    const replacement: Call = async (...args) => {
      if (point(`handle.${name}`, path) === "torn") {
        const partial = name === "writeFile" || name === "appendFile" ? half(args[0]) : null;
        if (partial) await original.call(handle, partial);
        die();
      }
      return original.apply(handle, args);
    };
    Object.defineProperty(handle, name, { value: replacement, configurable: true });
  }
}

function install(): void {
  if (originals.size > 0) return;
  const promises = NodeFS.promises as unknown as Record<string, Call>;
  for (const name of CHANGING_CALLS) {
    const original = promises[name];
    if (!original) continue;
    originals.set(name, original);
    promises[name] = async (...args) => {
      // rename, link, copyFile and cp change their destination.
      const target = ["rename", "link", "copyFile", "cp"].includes(name) ? args[1] : args[0];
      if (point(name, target) === "torn") {
        if (name === "writeFile" || name === "appendFile") {
          const partial = half(args[1]);
          if (partial) await original.call(promises, args[0], partial);
        } else if (name === "copyFile") {
          const bytes = await NodeFS.promises.readFile(args[0] as string);
          await originals
            .get("writeFile")!
            .call(promises, args[1], bytes.subarray(0, Math.floor(bytes.length / 2)));
        }
        die();
      }
      return original.apply(promises, args);
    };
  }
  const open = promises["open"]!;
  originals.set("open", open);
  promises["open"] = async (...args) => {
    const writes = opensForWriting(args[1]);
    if (writes && point("open", args[0]) === "torn") die();
    const handle = (await open.apply(promises, args)) as NodeFS.promises.FileHandle;
    if (writes) instrumentHandle(handle, args[0]);
    return handle;
  };
  NodeModule.syncBuiltinESMExports();
}

/** Starts counting file changes and applies the plan. */
export function startFileFaults(next: FileFaultPlan): void {
  install();
  plan = next;
  seen = 0;
  failing = false;
  trace.length = 0;
}

/** Ends the plan and returns the points seen; the real file calls are back afterwards. */
export function stopFileFaults(): ReadonlyArray<FileFaultPoint> {
  const points = [...trace];
  plan = null;
  seen = 0;
  failing = false;
  trace.length = 0;
  const promises = NodeFS.promises as unknown as Record<string, Call>;
  for (const [name, original] of originals) promises[name] = original;
  originals.clear();
  NodeModule.syncBuiltinESMExports();
  return points;
}

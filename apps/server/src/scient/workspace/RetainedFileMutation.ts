// @effect-diagnostics nodeBuiltinImport:off
/** Durable retained-file mutations. Only the shared mutation service calls these under its locks. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

const Identity = Schema.Struct({ dev: Schema.String, ino: Schema.String });
const Journal = Schema.Struct({
  version: Schema.Literal(1),
  target: Schema.String,
  expected: Schema.NullOr(Schema.String),
  desired: Schema.NullOr(Schema.String),
  mechanism: Schema.Literals(["exchange", "move-aside"]),
  phase: Schema.Literals([
    "preparing",
    "prepared",
    "displaced",
    "installed",
    "restoring",
    "returning-newer",
    "done",
  ]),
  stagedIdentity: Schema.NullOr(Identity),
  restoreSlot: Schema.NullOr(Identity),
  restoreTarget: Schema.NullOr(Identity),
  restoreSlotRevision: Schema.NullOr(Schema.String),
  restoreTargetRevision: Schema.NullOr(Schema.String),
  rounds: Schema.Number,
  visibleRetentionPath: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.Literals(["done", "skipped", "attention"])),
});
type Journal = typeof Journal.Type;
export const decodeRetainedRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Journal));
type Identity = typeof Identity.Type;

export interface RetainedMutationInput {
  readonly cwd: string;
  readonly relativePath: string;
  /** Trusted, host-owned directory on the same filesystem as the target. */
  readonly retentionDirectory: string;
  /** Stable id reused to recover an interrupted call. */
  readonly id: string;
  readonly expectedRevision: string | null;
  /** undefined on recovery; null means deletion. */
  readonly bytes?: Uint8Array | null;
  readonly executable?: boolean;
  readonly expectedRootIdentity?: Identity;
  /** Host-generated in-folder staging path for a blocking structural removal. */
  readonly visibleRetentionPath?: string;
  /** Absolute host-owned helper NodePath. Undefined selects the move-aside fallback. */
  readonly exchangeHelper?: string;
}
export interface RetainedMutationResult {
  readonly outcome: "done" | "skipped" | "attention";
  readonly recordDirectory: string;
  readonly retainedPath: string | null;
  readonly retainedRevision: string | null;
  readonly retainedIdentity: Identity | null;
}
export type MutationPoint =
  | "intent"
  | "staged"
  | "prepared"
  | "checked"
  | "displaced"
  | "installed"
  | "restore-intent"
  | "restored"
  | "return-intent"
  | "returned"
  | "between-rounds"
  | "round-admitted"
  | "done";
/** Fault/race seam for synthetic tests; never supplied by a transport. */
export interface RetainedMutationHooks {
  readonly at?: (point: MutationPoint) => Promise<void>;
}

export const bytesRevision = (bytes: Uint8Array) =>
  `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
const same = (a: Identity | null, b: Identity | null) =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export async function directoryIdentity(directory: string): Promise<Identity> {
  const stat = await NodeFSP.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace root changed.");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
export async function assertRootBinding(root: string, expected?: Identity) {
  if (expected && !same(await directoryIdentity(root), expected))
    throw new Error("Workspace root identity changed.");
}
export async function fileIdentity(file: string): Promise<Identity | null> {
  try {
    const stat = await NodeFSP.lstat(file, { bigint: true });
    if (stat.isDirectory()) return null;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Not a regular retained file: ${file}`);
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}
export async function fileRevision(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await NodeFSP.open(
      file,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    if ((await handle.stat()).isDirectory()) return null;
    if ((await handle.stat()).size > 50 * 1024 * 1024)
      throw new Error("File exceeds manuscript read budget.");
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${file}`);
    const hash = NodeCrypto.createHash("sha256");
    const buffer = Buffer.alloc(256 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 50 * 1024 * 1024) throw new Error("File exceeds manuscript read budget.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `sha256:${hash.digest("hex")}`;
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  } finally {
    await handle?.close();
  }
}
export async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await NodeFSP.open(directory, "r");
    await handle.sync();
  } catch (e) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? ""))
      throw e;
  } finally {
    await handle?.close();
  }
}
export async function durableJson(file: string, value: unknown) {
  const temporary = `${file}.tmp`;
  const handle = await NodeFSP.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
  await syncDirectory(NodePath.dirname(file));
}
function exchange(helper: string, left: string, right: string): Promise<void> {
  if (!NodePath.isAbsolute(helper))
    return Promise.reject(new Error("Exchange helper must be an absolute host NodePath."));
  return new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      helper,
      [left, right],
      { timeout: 10_000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" } },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}
async function exclusiveLink(source: string, destination: string) {
  try {
    await NodeFSP.link(source, destination);
    await syncDirectory(NodePath.dirname(destination));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** The target must already have passed containment revalidation inside the shared lock. */
export async function mutateRetainedFile(
  input: RetainedMutationInput,
  target: string,
  hooks: RetainedMutationHooks = {},
): Promise<RetainedMutationResult> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(input.id)) throw new Error("Invalid retained mutation id.");
  const retention = await NodeFSP.realpath(input.retentionDirectory);
  const rootStat = await NodeFSP.stat(retention);
  const recordDirectory = NodePath.join(retention, input.id);
  await NodeFSP.mkdir(recordDirectory, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  const recordStat = await NodeFSP.lstat(recordDirectory);
  if (!recordStat.isDirectory() || recordStat.isSymbolicLink())
    throw new Error("Unsafe retained record directory.");
  await syncDirectory(retention);
  // Existing record directories are allowed only for idempotent recovery.
  return run(input, target, recordDirectory, rootStat.dev, hooks);
}

async function run(
  input: RetainedMutationInput,
  target: string,
  recordDirectory: string,
  device: number,
  hooks: RetainedMutationHooks,
): Promise<RetainedMutationResult> {
  const journalPath = NodePath.join(recordDirectory, "record.json");
  const slot = NodePath.join(recordDirectory, "slot");
  const retained = NodePath.join(recordDirectory, "retained");
  const point = async (name: MutationPoint) => hooks.at?.(name);
  let record: Journal;
  const save = async (patch: Partial<Journal>) => {
    record = { ...record, ...patch };
    await durableJson(journalPath, record);
  };
  try {
    record = decodeRetainedRecord(await NodeFSP.readFile(journalPath, "utf8"));
  } catch (e) {
    if (!absent(e)) throw e;
    if (input.bytes === undefined)
      throw new Error("No retained mutation to recover.", { cause: e });
    record = {
      version: 1,
      target,
      expected: input.expectedRevision,
      desired: input.bytes === null ? null : bytesRevision(input.bytes),
      mechanism: input.exchangeHelper ? "exchange" : "move-aside",
      phase: "preparing",
      stagedIdentity: null,
      restoreSlot: null,
      restoreTarget: null,
      restoreSlotRevision: null,
      restoreTargetRevision: null,
      rounds: 0,
      visibleRetentionPath: input.visibleRetentionPath ?? null,
      outcome: null,
    };
    await save({});
    await point("intent");
  }
  if (
    record.target !== target ||
    record.expected !== input.expectedRevision ||
    record.visibleRetentionPath !== (input.visibleRetentionPath ?? null) ||
    (input.bytes !== undefined &&
      record.desired !== (input.bytes === null ? null : bytesRevision(input.bytes)))
  ) {
    throw new Error("Retained mutation id was reused with a different intent.");
  }
  const finish = async (outcome: RetainedMutationResult["outcome"]) => {
    await save({ phase: "done", outcome });
    await point("done");
    return result(outcome);
  };
  const result = async (
    outcome: RetainedMutationResult["outcome"],
  ): Promise<RetainedMutationResult> => {
    const keptPath = (await fileIdentity(retained))
      ? retained
      : (await fileIdentity(slot)) &&
          (!same(await fileIdentity(slot), record.stagedIdentity) ||
            (await fileRevision(slot)) !== record.desired)
        ? slot
        : null;
    return {
      outcome,
      recordDirectory,
      retainedPath: keptPath,
      retainedIdentity: keptPath ? await fileIdentity(keptPath) : null,
      retainedRevision: keptPath ? await fileRevision(keptPath) : null,
    };
  };
  if (record.phase === "done") return result(record.outcome!);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  // Persist each newly-created parent entry, not only the deepest file directory.
  let parent = NodePath.dirname(target);
  for (;;) {
    await syncDirectory(parent);
    if (parent === input.cwd) break;
    const next = NodePath.dirname(parent);
    if (next === parent || !parent.startsWith(`${input.cwd}${NodePath.sep}`))
      throw new Error("Unsafe target parent.");
    parent = next;
  }
  if ((await NodeFSP.stat(NodePath.dirname(target))).dev !== device)
    throw new Error("Retained copies must be on the target filesystem.");
  const exchangePaths = async () => {
    if (!input.exchangeHelper)
      throw new Error("This interrupted mutation requires its exchange helper.");
    await exchange(input.exchangeHelper, target, slot);
    await syncDirectory(NodePath.dirname(target));
    await syncDirectory(recordDirectory);
  };
  // Persist each restoration intent. Resume an unexecuted exact intent, recognize
  // an executed swap by identity, and never replay it over an intervening writer.
  const restore = async (): Promise<RetainedMutationResult> => {
    let resume = record.phase === "restoring" || record.phase === "returning-newer";
    for (;;) {
      let slotId = await fileIdentity(slot),
        targetId = await fileIdentity(target);
      if (!slotId) return finish("attention");
      if (resume) {
        const happened = same(targetId, record.restoreSlot);
        const waiting =
          same(slotId, record.restoreSlot) &&
          same(targetId, record.restoreTarget) &&
          (await fileRevision(slot)) === record.restoreSlotRevision &&
          (await fileRevision(target)) === record.restoreTargetRevision;
        if (!happened && !waiting) return finish("attention");
        if (waiting) {
          await exchangePaths();
          await point(record.phase === "restoring" ? "restored" : "returned");
        }
        resume = false;
      } else {
        if (!targetId) return finish((await exclusiveLink(slot, target)) ? "skipped" : "attention");
        if (record.rounds >= 3) return finish("attention");
        if (
          record.rounds > 0 &&
          (!same(targetId, record.restoreSlot) ||
            (await fileRevision(target)) !== record.restoreSlotRevision)
        )
          return finish("attention");
        const returning = record.rounds > 0;
        const installedRevision = record.restoreSlotRevision;
        if (returning) await point("round-admitted");
        await save({
          phase: returning ? "returning-newer" : "restoring",
          restoreSlot: slotId,
          restoreTarget: targetId,
          restoreSlotRevision: await fileRevision(slot),
          restoreTargetRevision: returning ? installedRevision : await fileRevision(target),
          rounds: record.rounds + 1,
        });
        await point(returning ? "return-intent" : "restore-intent");
        await exchangePaths();
        await point(returning ? "returned" : "restored");
      }
      slotId = await fileIdentity(slot);
      targetId = await fileIdentity(target);
      if (same(slotId, record.stagedIdentity) && (await fileRevision(slot)) === record.desired)
        return finish(record.rounds === 1 ? "skipped" : "attention");
      if (
        record.rounds > 1 &&
        same(slotId, record.restoreTarget) &&
        (await fileRevision(slot)) === record.restoreTargetRevision
      )
        return finish("attention");
      // If a writer replaced the file we just installed, its current path is newest;
      // leave it alone. Otherwise the displaced slot is the newer version to return.
      if (
        !same(targetId, record.restoreSlot) ||
        (await fileRevision(target)) !== record.restoreSlotRevision
      )
        return finish("attention");
      await point("between-rounds");
    }
  };
  if (record.phase === "restoring" || record.phase === "returning-newer") return restore();
  if (record.phase === "preparing") {
    // Fail unsupported volumes before displacing any manuscript file.
    const probe = NodePath.join(recordDirectory, "link-probe");
    const linked = NodePath.join(recordDirectory, "link-probe-copy");
    await NodeFSP.writeFile(probe, "", { mode: 0o600 });
    try {
      await NodeFSP.link(probe, linked);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await NodeFSP.rm(linked, { force: true });
      await NodeFSP.rm(probe, { force: true });
    }

    if (record.desired !== null) {
      if ((await fileIdentity(slot)) === null) {
        if (input.bytes === undefined || input.bytes === null) return finish("skipped");
        const handle = await NodeFSP.open(slot, "wx", input.executable ? 0o755 : 0o644);
        try {
          await handle.writeFile(input.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(recordDirectory);
      }
      await point("staged");
      if ((await fileRevision(slot)) !== record.desired) return finish("attention");
    }
    await save({ phase: "prepared", stagedIdentity: await fileIdentity(slot) });
    await point("prepared");
  }
  // A crash after exchange but before the phase write leaves the staged identity
  // at target, not slot. A same-content foreign file is never treated as ours.
  if (record.mechanism === "exchange" && record.desired !== null && record.expected !== null) {
    const slotId = await fileIdentity(slot);
    if (!same(slotId, record.stagedIdentity)) {
      if (slotId === null) return finish("attention");
      if ((await fileRevision(slot)) !== record.expected) return restore();
      if (!same(await fileIdentity(target), record.stagedIdentity)) return finish("attention");
      return finish("done");
    }
    if ((await fileRevision(target)) !== record.expected) return finish("skipped");
    await point("checked");
    await exchangePaths();
    await point("displaced");
    await save({ phase: "displaced" });
    if ((await fileRevision(slot)) !== record.expected) return restore();
    await point("installed");
    if (!same(await fileIdentity(target), record.stagedIdentity)) return finish("attention");
    return finish("done");
  }
  // Move-aside for removal/fallback. A non-null expected file already absent is
  // never silently declared deleted: it may have been renamed by a writer.
  let retainedId = await fileIdentity(retained);
  if (record.expected !== null && retainedId === null) {
    if ((await fileRevision(target)) !== record.expected) return finish("skipped");
    await point("checked");
    if (record.visibleRetentionPath) {
      const stage = record.visibleRetentionPath;
      if (NodePath.dirname(stage) !== input.cwd) throw new Error("Unsafe structural staging path.");
      try {
        await NodeFSP.link(target, stage);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      if (
        !same(await fileIdentity(stage), await fileIdentity(target)) ||
        (await fileRevision(stage)) !== record.expected
      )
        return finish("attention");
      await syncDirectory(input.cwd);
    }
    try {
      await NodeFSP.rename(target, retained);
    } catch (e) {
      if (absent(e)) return finish("skipped");
      throw e;
    }
    await syncDirectory(NodePath.dirname(target));
    await syncDirectory(recordDirectory);
    await point("displaced");
    await save({ phase: "displaced" });
    retainedId = await fileIdentity(retained);
  }
  if (retainedId && (await fileRevision(retained)) !== record.expected) {
    await exclusiveLink(retained, target);
    return finish("attention");
  }
  if (record.desired === null) {
    return finish((await fileIdentity(target)) === null ? "done" : "attention");
  }
  if (same(await fileIdentity(target), record.stagedIdentity)) return finish("done");
  await point("checked");
  // File/folder substitution removes only an empty directory, never contents.
  try {
    if ((await NodeFSP.lstat(target)).isDirectory()) await pruneEmptyDirectories(target);
  } catch (e) {
    if (!absent(e)) return finish("attention");
  }
  if (!(await exclusiveLink(slot, target))) return finish("attention");
  await point("installed");
  await save({ phase: "installed" });
  return finish("done");
}

/** Retention is deliberately not released here: late handles may still write. */
export async function recheckRetainedFile(
  result: RetainedMutationResult,
  expectedRevision: string | null,
) {
  const revision = result.retainedPath ? await fileRevision(result.retainedPath) : null;
  return { ...result, retainedRevision: revision, changed: revision !== expectedRevision };
}

async function pruneEmptyDirectories(directory: string): Promise<void> {
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe structural directory.");
  for (const child of await NodeFSP.readdir(directory)) {
    const path = NodePath.join(directory, child);
    if (!(await NodeFSP.lstat(path)).isDirectory())
      throw new Error("Structural directory has user content.");
    await pruneEmptyDirectories(path);
  }
  await NodeFSP.rmdir(directory);
  await syncDirectory(NodePath.dirname(directory));
}

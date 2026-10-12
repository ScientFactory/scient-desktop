// @effect-diagnostics nodeBuiltinImport:off
/** Durable intent, exact-object retention and bounded compensation under native ownership. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  bindNativeFilePublication,
  bindNativeFilePublicationParent,
  nativeFilePublicationCapabilities,
  ensureNativePrivateRetentionDirectory,
  withNativeFilePublicationLease,
  type NativeFileBinding,
  type NativeFileIdentity,
  type NativeFilePublicationLease,
  type NativeFileLeaseBinding,
  type NativeFilePublicationResult,
} from "./NativeFilePublication.ts";

const Identity = Schema.Struct({ dev: Schema.String, ino: Schema.String });
const Binding = Schema.Struct({
  rootPath: Schema.String,
  parentRelativePath: Schema.String,
  recordPath: Schema.String,
  rootIdentity: Identity,
  parentIdentity: Identity,
  recordIdentity: Identity,
});
const LegacyJournal = Schema.Struct({
  version: Schema.Literal(1),
  target: Schema.String,
  expected: Schema.NullOr(Schema.String),
  desired: Schema.NullOr(Schema.String),
  mechanism: Schema.Literals(["exchange", "move-aside"]),
  phase: Schema.Literals([
    "preparing",
    "prepared",
    "displaced",
    "installing",
    "installed",
    "restoring",
    "returning-newer",
    "done",
  ]),
  installBoundary: Schema.optionalKey(Schema.Literal(true)),
  stagedIdentity: Schema.NullOr(Identity),
  restoreSlot: Schema.NullOr(Identity),
  restoreTarget: Schema.NullOr(Identity),
  restoreSlotRevision: Schema.NullOr(Schema.String),
  restoreTargetRevision: Schema.NullOr(Schema.String),
  rounds: Schema.Number,
  visibleRetentionPath: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.Literals(["done", "skipped", "attention"])),
});
const Journal = Schema.Struct({
  version: Schema.Literal(2),
  mutationId: Schema.String,
  target: Schema.String,
  requestedPath: Schema.optionalKey(Schema.String),
  requestedDestination: Schema.optionalKey(Schema.String),
  expectedMutationEpoch: Schema.optionalKey(Schema.String),
  publicationEpoch: Schema.optionalKey(Schema.String),
  destination: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["write", "create", "rename", "delete", "prune"]),
  condition: Schema.Literals(["revision", "unguarded", "absent"]),
  publication: Schema.Literals(["exchange", "create", "capture"]),
  expected: Schema.NullOr(Schema.String),
  desired: Schema.NullOr(Schema.String),
  executable: Schema.Boolean,
  guardMaxBytes: Schema.NullOr(Schema.Number),
  binding: Schema.NullOr(Binding),
  destinationBinding: Schema.NullOr(Binding),
  phase: Schema.Literals([
    "preparing",
    "prepared",
    "publishing",
    "displaced",
    "installing",
    "installed",
    "restoring",
    "done",
  ]),
  installBoundary: Schema.Literal(true),
  stagedIdentity: Schema.NullOr(Identity),
  capturedIdentity: Schema.NullOr(Identity),
  provisionalIdentity: Schema.NullOr(Identity),
  publishedIdentity: Schema.NullOr(Identity),
  publishedRevision: Schema.NullOr(Schema.String),
  currentRevision: Schema.NullOr(Schema.String),
  sourceMutation: Schema.optionalKey(Schema.Boolean),
  failure: Schema.NullOr(
    Schema.Literals(["revision", "exists", "target", "unavailable", "recovery"]),
  ),
  visibleRetentionPath: Schema.NullOr(Schema.String),
  retainedAt: Schema.Number,
  generation: Schema.Number,
  discarded: Schema.Array(Schema.String),
  reviewedBinding: Schema.NullOr(Binding),
  reviewedRevision: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.Literals(["done", "skipped", "attention"])),
});
export type RetainedRecord = typeof Journal.Type;
export const decodeRetainedRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([Journal, LegacyJournal])),
);
const decodeCurrent = Schema.decodeUnknownSync(Schema.fromJsonString(Journal));
export type Identity = NativeFileIdentity;
export interface RetainedMutationInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly requestedPath?: string;
  readonly requestedDestination?: string;
  /** Server-generated private directory on the authorized parent's volume. */
  readonly retentionDirectory: string;
  readonly id: string;
  readonly mutationId?: string;
  readonly expectedRevision: string | null;
  readonly bytes?: Uint8Array | null;
  readonly executable?: boolean;
  readonly expectedRootIdentity?: Identity;
  readonly visibleRetentionPath?: string;
  readonly nativePublicationHelper?: string;
  readonly kind?: "write" | "create" | "rename" | "delete" | "prune";
  readonly condition?: "revision" | "unguarded" | "absent";
  readonly destination?: string;
  readonly guardMaxBytes?: number;
  readonly expectedMutationEpoch?: string;
  readonly retentionLimitBytes?: number | null;
  /** Internal ownership only; never accepted from a transport. */
  readonly binding?: NativeFileBinding;
  readonly destinationBinding?: NativeFileBinding;
  readonly lease?: NativeFilePublicationLease;
}
export interface RetainedMutationResult {
  readonly outcome: "done" | "skipped" | "attention";
  readonly recordDirectory: string;
  readonly retainedPath: string | null;
  readonly retainedRevision: string | null;
  readonly retainedIdentity: Identity | null;
  readonly mutationId?: string;
  readonly revision?: string | null;
  readonly currentRevision?: string | null;
  readonly failure?: "revision" | "exists" | "target" | "unavailable" | "recovery" | null;
  readonly retainedPaths?: ReadonlyArray<string>;
  readonly sourceMutation?: boolean;
  /** Exact epoch captured under the original publication fence; replay never refreshes it. */
  readonly publicationEpoch?: string;
}
export type MutationPoint =
  | "intent"
  | "staged"
  | "prepared"
  | "checked"
  | "displaced"
  | "install-intent"
  | "installed"
  | "restore-intent"
  | "restored"
  | "return-intent"
  | "returned"
  | "between-rounds"
  | "round-admitted"
  | "done";
export interface RetainedMutationHooks {
  readonly at?: (point: MutationPoint) => Promise<void>;
}
export class RetainedMutationError extends Error {
  readonly reason: "intent" | "unavailable" | "target" | "recovery";
  readonly recoveryId: string;
  readonly retainedPaths: ReadonlyArray<string>;
  constructor(
    reason: "intent" | "unavailable" | "target" | "recovery",
    message: string,
    recoveryId: string,
    retainedPaths: ReadonlyArray<string> = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RetainedMutationError";
    this.reason = reason;
    this.recoveryId = recoveryId;
    this.retainedPaths = retainedPaths;
  }
}
export const bytesRevision = (bytes: Uint8Array) =>
  `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
export const sameIdentity = (a: Identity | null | undefined, b: Identity | null | undefined) =>
  a != null && b != null && a.dev === b.dev && a.ino === b.ino;

/** Fresh discovery only; physical identity ordering is shared by aliases, nested roots and servers. */
export async function publicationLeaseBindings(
  helper: string,
  bindings: ReadonlyArray<NativeFileLeaseBinding>,
  privateDirectories: ReadonlyArray<string> = [],
): Promise<NativeFileLeaseBinding[]> {
  const parents = new Map<string, NativeFileLeaseBinding>();
  const identities = new Map<string, Identity>();
  const nativeParents = new Map<string, NativeFileLeaseBinding>();
  const expanded = new Set<string>();
  const keyFor = (identity: Identity) => `${identity.dev}:${identity.ino}`;
  const include = (binding: NativeFileLeaseBinding, mode: "shared" | "exclusive") => {
    const key = keyFor(binding.parentIdentity),
      previous = parents.get(key);
    if (!previous || mode === "exclusive")
      parents.set(key, binding.mode === mode ? binding : { ...binding, mode });
  };
  const identityFor = async (path: string) => {
    let identity = identities.get(path);
    if (!identity) {
      identity = await directoryIdentity(path);
      identities.set(path, identity);
    }
    return identity;
  };
  const bindParent = async (path: string) => {
    let binding = nativeParents.get(path);
    if (!binding) {
      const identity = await identityFor(path);
      binding = await bindNativeFilePublicationParent(helper, path, "");
      if (
        !sameIdentity(binding.rootIdentity, identity) ||
        !sameIdentity(binding.parentIdentity, identity)
      )
        throw new Error("Workspace directory binding changed.");
      nativeParents.set(path, binding);
    }
    return binding;
  };
  const expand = async (binding: NativeFileLeaseBinding, mode: "shared" | "exclusive") => {
    include(binding, mode);
    let parent = NodePath.join(binding.rootPath, binding.parentRelativePath);
    const volumeIdentity = binding.parentIdentity;
    while (!expanded.has(parent)) {
      expanded.add(parent);
      const next = NodePath.dirname(parent);
      if (next === parent || (await identityFor(next)).dev !== volumeIdentity.dev) break;
      include(await bindParent(next), "shared");
      parent = next;
    }
    if (!parents.has(keyFor(binding.rootIdentity))) {
      const root = await bindParent(binding.rootPath);
      if (!sameIdentity(root.parentIdentity, binding.rootIdentity))
        throw new Error("Workspace directory binding changed.");
      include(root, "shared");
    }
  };
  for (const binding of bindings) await expand(binding, binding.mode ?? "exclusive");
  // Completed records still own their private directory exclusively and every same-volume ancestor.
  for (const directory of privateDirectories)
    await expand(await bindParent(directory), "exclusive");
  return [...parents.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, binding]) => binding);
}
const absent = (e: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");
export const retainedFileNames = ["slot", "retained", "provisional"] as const;
export async function directoryIdentity(directory: string): Promise<Identity> {
  const stat = await NodeFSP.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Workspace directory binding changed.");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
export async function assertRootBinding(root: string, expected?: Identity) {
  if (expected && !sameIdentity(await directoryIdentity(root), expected))
    throw new RetainedMutationError("target", "Workspace root identity changed.", "root-binding");
}
export async function fileIdentity(file: string): Promise<Identity | null> {
  try {
    const stat = await NodeFSP.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}
/** Whole-file hashing is streaming; a prefix digest is never a manuscript CAS guard. */
export async function fileRevision(file: string): Promise<string | null> {
  let handle;
  try {
    const named = await NodeFSP.lstat(file);
    if (!named.isFile() || named.isSymbolicLink()) return null;
    handle = await NodeFSP.open(
      file,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
    if (!(await handle.stat()).isFile()) return null;
    const hash = NodeCrypto.createHash("sha256"),
      buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `sha256:${hash.digest("hex")}`;
  } catch (e) {
    if (absent(e) || (e as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw e;
  } finally {
    await handle?.close();
  }
}

export async function inspectGuardedFile(file: string, maxBytes?: number) {
  let handle;
  try {
    handle = await NodeFSP.open(
      file,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return null;
    const hash = NodeCrypto.createHash("sha256"),
      leading = NodeCrypto.createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    const limit = maxBytes ?? Number.MAX_SAFE_INTEGER,
      leadingLimit = maxBytes ?? 1024 * 1024;
    let byteLength = 0,
      binary = false;
    while (byteLength <= limit) {
      const length = Math.min(buffer.length, limit + 1 - byteLength);
      if (length <= 0) break;
      const { bytesRead } = await handle.read(buffer, 0, length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (byteLength < leadingLimit)
        leading.update(chunk.subarray(0, Math.min(bytesRead, leadingLimit - byteLength)));
      binary ||= chunk.includes(0);
      byteLength += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== after.size ||
      stat.mtimeNs !== after.mtimeNs ||
      stat.ctimeNs !== after.ctimeNs
    )
      throw new RetainedMutationError(
        "target",
        "The descriptor changed during revision inspection.",
        "revision-inspection",
      );
    return {
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
      byteLength,
      binary,
      revision: `sha256:${hash.digest("hex")}`,
      leadingRevision: `sha256:${leading.digest("hex")}`,
    };
  } catch (cause) {
    if (absent(cause) || (cause as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw cause;
  } finally {
    await handle?.close();
  }
}
export async function leadingFileRevision(file: string, maxBytes = 1024 * 1024): Promise<string> {
  const snapshot = await inspectGuardedFile(file, maxBytes);
  if (!snapshot) throw new Error("Captured entry is not a regular file.");
  return snapshot.leadingRevision;
}
export async function syncDirectory(directory: string) {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (e) {
    if (
      HostProcessPlatform.defaultValue() !== "win32" ||
      !["EINVAL", "EPERM", "EISDIR"].includes((e as NodeJS.ErrnoException).code ?? "")
    )
      throw e;
  } finally {
    await handle.close();
  }
}
export async function durableJson(file: string, value: unknown) {
  const temporary = `${file}.tmp`;
  const handle = await NodeFSP.open(
    temporary,
    NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_TRUNC |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
  await syncDirectory(NodePath.dirname(file));
}
export async function assertPrivateRetention(directory: string) {
  if (!NodePath.isAbsolute(directory) || (await NodeFSP.realpath(directory)) !== directory)
    throw new RetainedMutationError(
      "unavailable",
      "Retention must be a canonical host-private directory.",
      "storage",
    );
  const stat = await NodeFSP.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (HostProcessPlatform.defaultValue() !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new RetainedMutationError(
      "unavailable",
      "Retention directory is not private to the server owner.",
      "storage",
    );
}
export async function prepareRetainedDirectory(retention: string, id: string, helper: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(id))
    throw new RetainedMutationError("intent", "Invalid retained mutation identity.", id);
  await assertPrivateRetention(retention);
  const directory = NodePath.join(retention, id);
  try {
    await assertPrivateRetention(directory);
  } catch (cause) {
    if (!isRetainedMissing(cause)) throw cause;
    const prepared = await ensureNativePrivateRetentionDirectory(helper, directory);
    if (prepared !== directory)
      throw new RetainedMutationError(
        "target",
        "Retained directory authority changed during creation.",
        id,
      );
    await assertPrivateRetention(directory);
  }
  return directory;
}
export async function retainedPaths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const leaf of retainedFileNames) {
    const file = NodePath.join(directory, leaf);
    try {
      await NodeFSP.lstat(file);
      paths.push(file);
    } catch (e) {
      if (!absent(e)) throw e;
    }
  }
  return paths;
}
export async function retainedStorageBytes(retention: string): Promise<number> {
  let total = 0;
  for (const entry of await NodeFSP.readdir(retention, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/u.test(entry.name)) continue;
    const directory = NodePath.join(retention, entry.name);
    await assertPrivateRetention(directory);
    for (const file of await retainedPaths(directory)) total += (await NodeFSP.lstat(file)).size;
  }
  return total;
}
export async function readRetainedRecord(directory: string) {
  await assertPrivateRetention(directory);
  return decodeRetainedRecord(
    await NodeFSP.readFile(NodePath.join(directory, "record.json"), "utf8"),
  );
}

export async function retainedMutationReceipt(
  directory: string,
): Promise<RetainedMutationResult | null> {
  const record = await readRetainedRecord(directory);
  if (record.version !== 2 || record.phase !== "done") return null;
  const paths = await retainedPaths(directory);
  const kept = paths.find((path) => NodePath.basename(path) === "retained") ?? paths[0] ?? null;
  return {
    outcome: record.outcome ?? "attention",
    recordDirectory: directory,
    retainedPath: kept,
    retainedRevision: kept ? await fileRevision(kept) : null,
    retainedIdentity: kept ? await fileIdentity(kept) : null,
    mutationId: record.mutationId,
    revision: record.publishedRevision,
    currentRevision: record.currentRevision,
    failure: record.failure,
    retainedPaths: paths,
    ...(record.sourceMutation === undefined ? {} : { sourceMutation: record.sourceMutation }),
    ...(record.publicationEpoch === undefined ? {} : { publicationEpoch: record.publicationEpoch }),
  };
}
export async function mutateRetainedFile(
  input: RetainedMutationInput,
  target: string,
  hooks: RetainedMutationHooks = {},
): Promise<RetainedMutationResult> {
  const helper = input.nativePublicationHelper;
  if (!helper)
    throw new RetainedMutationError(
      "unavailable",
      "Native file publication helper is unavailable; no fallback is permitted.",
      input.id,
    );
  const kind = input.kind ?? (input.bytes === null ? "delete" : "write"),
    condition = input.condition ?? (input.expectedRevision === null ? "absent" : "revision");
  const capabilities = await nativeFilePublicationCapabilities(helper, input.cwd);
  if (
    !capabilities.strictCurrentRoot ||
    !capabilities.publicationLease ||
    !capabilities.exclusiveMove ||
    !capabilities.exclusiveLink
  )
    throw new RetainedMutationError(
      "unavailable",
      "This host has not qualified retained publication ownership.",
      input.id,
    );
  const parent = await bindNativeFilePublicationParent(
    helper,
    input.cwd,
    NodePath.relative(input.cwd, NodePath.dirname(target)),
  );
  const parentCapabilities = await nativeFilePublicationCapabilities(
    helper,
    NodePath.join(parent.rootPath, parent.parentRelativePath),
  );
  const creation =
    kind === "create" ||
    condition === "absent" ||
    (kind === "write" && condition === "unguarded" && (await fileIdentity(target)) === null);
  if (
    (kind === "write" || kind === "create") &&
    !(creation
      ? capabilities.atomicCreateMetadata && parentCapabilities.atomicCreateMetadata
      : capabilities.atomicExchange)
  ) {
    let previous;
    try {
      previous = await readRetainedRecord(NodePath.join(input.retentionDirectory, input.id));
    } catch (cause) {
      if (!absent(cause)) throw cause;
    }
    if (!previous) {
      if (kind !== "write" || condition === "absent" || input.bytes == null)
        throw new RetainedMutationError(
          "unavailable",
          "This host does not support the required atomic file publication operation.",
          input.id,
        );
      const publicationParent = parent;
      const qualifyNoop = async () => {
        const snapshot = await inspectGuardedFile(target, input.guardMaxBytes);
        const current = await bindNativeFilePublicationParent(
          helper,
          publicationParent.rootPath,
          publicationParent.parentRelativePath,
        );
        return (
          snapshot !== null &&
          snapshot.revision === bytesRevision(input.bytes!) &&
          (condition !== "revision" || snapshot.revision === input.expectedRevision) &&
          (input.guardMaxBytes === undefined ||
            (snapshot.byteLength <= input.guardMaxBytes && !snapshot.binary)) &&
          sameIdentity(snapshot.identity, await fileIdentity(target)) &&
          sameIdentity(current.rootIdentity, publicationParent.rootIdentity) &&
          sameIdentity(current.parentIdentity, publicationParent.parentIdentity)
        );
      };
      const noop = input.lease
        ? await qualifyNoop()
        : await withNativeFilePublicationLease(
            helper,
            await publicationLeaseBindings(helper, [publicationParent]),
            qualifyNoop,
            { mode: "exclusive" },
          );
      if (!noop)
        throw new RetainedMutationError(
          "unavailable",
          "New-byte publication was refused before retained admission or staging.",
          input.id,
        );
    }
  }
  const directory = await prepareRetainedDirectory(input.retentionDirectory, input.id, helper);
  const binding =
    input.binding ??
    (await bindNativeFilePublication(helper, {
      rootPath: input.cwd,
      parentRelativePath: NodePath.relative(input.cwd, NodePath.dirname(target)),
      recordPath: directory,
    }));
  if (binding.recordPath !== directory)
    throw new RetainedMutationError("target", "Retained record binding mismatch.", input.id);
  await assertRootBinding(binding.rootPath, input.expectedRootIdentity);
  const destinationBinding =
    input.destinationBinding ??
    (input.destination
      ? await bindNativeFilePublication(helper, {
          rootPath: input.cwd,
          parentRelativePath: NodePath.relative(input.cwd, NodePath.dirname(input.destination)),
          recordPath: directory,
        })
      : undefined);
  const boundInput = { ...input, binding, ...(destinationBinding ? { destinationBinding } : {}) };
  if (input.lease) return run(boundInput, target, directory, input.lease, hooks);
  const bindings = await publicationLeaseBindings(
    helper,
    destinationBinding ? [binding, destinationBinding] : [binding],
    [directory],
  );
  return withNativeFilePublicationLease(
    helper,
    bindings,
    (lease) => run(boundInput, target, directory, lease, hooks),
    { mode: "exclusive" },
  );
}

async function run(
  input: RetainedMutationInput & { binding: NativeFileBinding },
  target: string,
  directory: string,
  lease: NativeFilePublicationLease,
  hooks: RetainedMutationHooks,
): Promise<RetainedMutationResult> {
  const journalPath = NodePath.join(directory, "record.json"),
    slot = NodePath.join(directory, "slot"),
    retained = NodePath.join(directory, "retained"),
    provisional = NodePath.join(directory, "provisional");
  const point = async (name: MutationPoint) => {
    lease.assertHeld();
    await hooks.at?.(name);
    lease.assertHeld();
  };
  const kind = input.kind ?? (input.bytes === null ? "delete" : "write");
  const condition = input.condition ?? (input.expectedRevision === null ? "absent" : "revision");
  let record: RetainedRecord;
  let previous;
  try {
    previous = await readRetainedRecord(directory);
  } catch (e) {
    if (!absent(e)) throw e;
  }
  if (previous?.version === 1) {
    // A legacy journal has no authority identities. Preserve all entries, never adopt a reused root/path.
    throw new RetainedMutationError(
      "recovery",
      "Legacy retained operation requires explicit recovery; its root binding is unknown.",
      input.id,
      await retainedPaths(directory),
    );
  }
  if (previous) {
    record = previous;
    if (
      record.mutationId !== (input.mutationId ?? input.id) ||
      record.target !== target ||
      record.destination !== (input.destination ?? null) ||
      record.kind !== kind ||
      record.condition !== condition ||
      record.expected !== input.expectedRevision ||
      record.executable !== (input.executable ?? false) ||
      record.guardMaxBytes !== (input.guardMaxBytes ?? null) ||
      (record.expectedMutationEpoch ?? null) !== (input.expectedMutationEpoch ?? null) ||
      record.visibleRetentionPath !== (input.visibleRetentionPath ?? null) ||
      (input.bytes !== undefined &&
        record.desired !== (input.bytes === null ? null : bytesRevision(input.bytes)))
    )
      throw new RetainedMutationError(
        "intent",
        "Retained mutation id was reused with a different intent.",
        input.id,
      );
  } else {
    if (input.bytes === undefined && !["rename", "delete", "prune"].includes(kind))
      throw new RetainedMutationError("recovery", "No durable intent to recover.", input.id);
    const entry = await NodeFSP.lstat(target).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    const publication =
      kind === "create" ||
      condition === "absent" ||
      (kind === "write" && condition === "unguarded" && entry === null)
        ? "create"
        : kind === "write"
          ? "exchange"
          : "capture";
    record = {
      version: 2,
      mutationId: input.mutationId ?? input.id,
      target,
      ...(input.requestedPath ? { requestedPath: input.requestedPath } : {}),
      destination: input.destination ?? null,
      kind,
      condition,
      publication,
      expected: input.expectedRevision,
      desired: input.bytes == null ? null : bytesRevision(input.bytes),
      executable: input.executable ?? false,
      guardMaxBytes: input.guardMaxBytes ?? null,
      binding: input.binding,
      destinationBinding: input.destinationBinding ?? null,
      phase: "preparing",
      installBoundary: true,
      stagedIdentity: null,
      capturedIdentity: null,
      provisionalIdentity: null,
      publishedIdentity: null,
      publishedRevision: null,
      currentRevision: null,
      failure: null,
      visibleRetentionPath: input.visibleRetentionPath ?? null,
      retainedAt: await Effect.runPromise(Clock.currentTimeMillis),
      generation: 0,
      discarded: [],
      reviewedBinding: null,
      reviewedRevision: null,
      outcome: null,
    };
    if (input.requestedDestination)
      record = { ...record, requestedDestination: input.requestedDestination };
    record = {
      ...record,
      sourceMutation: false,
      ...(input.expectedMutationEpoch === undefined
        ? {}
        : { expectedMutationEpoch: input.expectedMutationEpoch }),
    };
  }
  const save = async (patch: Partial<RetainedRecord>) => {
    lease.assertHeld();
    record = { ...record, ...patch, generation: record.generation + 1 };
    await durableJson(journalPath, record);
  };
  const result = async (): Promise<RetainedMutationResult> => {
    const paths = await retainedPaths(directory);
    const kept = paths.find((p) => NodePath.basename(p) === "retained") ?? paths[0] ?? null;
    return {
      outcome: record.outcome ?? "attention",
      recordDirectory: directory,
      retainedPath: kept,
      retainedRevision: kept ? await fileRevision(kept) : null,
      retainedIdentity: kept ? await fileIdentity(kept) : null,
      mutationId: record.mutationId,
      revision: record.publishedRevision,
      currentRevision: record.currentRevision,
      failure: record.failure,
      retainedPaths: paths,
      ...(record.sourceMutation === undefined ? {} : { sourceMutation: record.sourceMutation }),
      ...(record.publicationEpoch === undefined
        ? {}
        : { publicationEpoch: record.publicationEpoch }),
    };
  };
  const finish = async (
    outcome: RetainedMutationResult["outcome"],
    failure: RetainedRecord["failure"] = null,
  ) => {
    await save({ phase: "done", outcome, failure });
    await point("done");
    return result();
  };
  const bindingMatches = (a: NativeFileBinding | null, b: NativeFileBinding | undefined) =>
    a != null &&
    b != null &&
    a.rootPath === b.rootPath &&
    a.parentRelativePath === b.parentRelativePath &&
    sameIdentity(a.rootIdentity, b.rootIdentity) &&
    sameIdentity(a.parentIdentity, b.parentIdentity) &&
    sameIdentity(a.recordIdentity, b.recordIdentity);
  if (record.phase === "done") return result(); // Receipt, not equality or permission to reapply.
  if (previous && record.sourceMutation === undefined) return finish("attention", "recovery");
  if (
    !bindingMatches(record.binding, input.binding) ||
    (record.destination !== null &&
      !bindingMatches(record.destinationBinding, input.destinationBinding))
  )
    return finish("attention", "target");
  const capabilities = await nativeFilePublicationCapabilities(
    input.nativePublicationHelper!,
    input.binding.rootPath,
  );
  if (
    !capabilities.strictCurrentRoot ||
    !capabilities.publicationLease ||
    !capabilities.exclusiveMove ||
    !capabilities.exclusiveLink
  )
    throw new RetainedMutationError(
      "unavailable",
      "Qualified native publication capability is unavailable.",
      input.id,
    );
  const command = async (
    operation: "capture" | "create" | "exchange" | "link" | "restore" | "move" | "rmdir",
    sourceName: string,
    destinationName: string,
    binding = input.binding,
  ): Promise<NativeFilePublicationResult> =>
    lease.run({ operation, sourceName, destinationName, binding });
  const good = (reply: NativeFilePublicationResult) =>
    reply.outcome === "applied" &&
    reply.code === 0 &&
    Object.values(reply.flush).every((v) => v <= 0) &&
    reply.containment !== "bound-object";
  const regular = async (file: string) => {
    try {
      const stat = await NodeFSP.lstat(file);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch (e) {
      if (absent(e)) return false;
      throw e;
    }
  };
  const guarded = async (file: string) => {
    if (!(await regular(file))) return false;
    if (condition !== "revision") return true;
    const snapshot = await inspectGuardedFile(file, input.guardMaxBytes);
    if (!snapshot) return false;
    record = {
      ...record,
      currentRevision:
        input.guardMaxBytes === undefined ? snapshot.revision : snapshot.leadingRevision,
    };
    if (
      input.guardMaxBytes !== undefined &&
      (snapshot.byteLength > input.guardMaxBytes || snapshot.binary)
    )
      return false;
    return snapshot.revision === record.expected;
  };
  // This durable refusal is definitive: no native source syscall was admitted.
  if (
    record.sourceMutation === false &&
    (record.phase === "preparing" || record.phase === "prepared") &&
    condition === "revision" &&
    !(await guarded(target))
  )
    return finish("skipped", record.currentRevision === null ? "target" : "revision");
  if (
    record.sourceMutation === false &&
    (record.phase === "preparing" || record.phase === "prepared") &&
    kind === "rename" &&
    record.destination !== null
  ) {
    const occupied = await NodeFSP.lstat(record.destination).then(
      () => true,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return false;
        throw cause;
      },
    );
    if (occupied) return finish("skipped", "exists");
  }
  const restoreCaptured = async (
    fileName: "slot" | "retained",
    conflict: "revision" | "target" | "exists",
  ) => {
    await save({ phase: "restoring", failure: conflict });
    await point("restore-intent");
    const reply = await command(
      (await regular(NodePath.join(directory, fileName))) ? "link" : "restore",
      fileName,
      NodePath.basename(target),
    );
    await point("restored");
    if (!good(reply)) return finish("attention", "recovery");
    return finish("attention", conflict);
  };
  const compensateExchange = async (conflict: "revision" | "target") => {
    // Capture whatever now occupies the live name. Never check-then-unlink or overwrite during compensation.
    await save({ phase: "restoring", failure: conflict });
    await point("restore-intent");
    const capture = await command("capture", NodePath.basename(target), "provisional");
    if (!good(capture)) return finish("attention", "recovery");
    const actual = await fileIdentity(provisional);
    await save({ provisionalIdentity: actual });
    if (
      !sameIdentity(actual, record.stagedIdentity) ||
      (await fileRevision(provisional)) !== record.desired
    ) {
      // A foreign D was captured; return D exclusively. B and C remain private; no second capture loop.
      await command(
        (await regular(provisional)) ? "link" : "restore",
        "provisional",
        NodePath.basename(target),
      );
      return finish("attention", "recovery");
    }
    const restoration = await command(
      (await regular(slot)) ? "link" : "restore",
      "slot",
      NodePath.basename(target),
    );
    await point("restored");
    return finish("attention", good(restoration) ? conflict : "recovery");
  };
  if (!previous) {
    await save({});
    await point("intent");
  }
  if (
    record.phase === "preparing" &&
    record.sourceMutation === false &&
    kind === "write" &&
    condition !== "absent" &&
    record.desired !== null
  ) {
    const snapshot = await inspectGuardedFile(target, input.guardMaxBytes);
    if (
      snapshot &&
      (input.guardMaxBytes === undefined ||
        (snapshot.byteLength <= input.guardMaxBytes && !snapshot.binary)) &&
      snapshot.revision === record.desired &&
      sameIdentity(snapshot.identity, await fileIdentity(target))
    ) {
      const currentBinding = await bindNativeFilePublication(input.nativePublicationHelper!, {
        rootPath: input.binding.rootPath,
        parentRelativePath: input.binding.parentRelativePath,
        recordPath: directory,
      });
      if (!bindingMatches(input.binding, currentBinding)) return finish("attention", "target");
      await save({
        publishedIdentity: snapshot.identity,
        publishedRevision: record.desired,
        currentRevision: record.desired,
        sourceMutation: false,
      });
      return finish("done");
    }
  }
  if (
    (record.publication === "create" && !capabilities.atomicCreateMetadata) ||
    (record.publication === "exchange" && !capabilities.atomicExchange)
  )
    return finish(record.sourceMutation === false ? "skipped" : "attention", "unavailable");
  // Reconstruct effects by private object identity, never by a same-content live pathname.
  if (!["preparing", "prepared"].includes(record.phase)) {
    if (
      record.publication === "create" &&
      record.publishedIdentity &&
      sameIdentity(record.publishedIdentity, record.stagedIdentity)
    )
      return finish("attention", "unavailable");
    if (
      record.publication === "exchange" &&
      kind === "write" &&
      ["publishing", "displaced"].includes(record.phase)
    ) {
      if (sameIdentity(await fileIdentity(slot), record.stagedIdentity))
        return finish("attention", "recovery");
      if (
        !sameIdentity(await fileIdentity(slot), record.capturedIdentity) ||
        !(await guarded(slot))
      )
        return finish("attention", "recovery");
      if (
        !sameIdentity(await fileIdentity(target), record.stagedIdentity) ||
        (await fileRevision(target)) !== record.desired
      )
        return finish("attention", "recovery");
      await save({ publishedIdentity: record.stagedIdentity, publishedRevision: record.desired });
      return finish("done");
    }
    if (
      kind === "delete" &&
      ["publishing", "displaced"].includes(record.phase) &&
      sameIdentity(await fileIdentity(retained), record.capturedIdentity) &&
      (await guarded(retained))
    )
      return finish("done");
    if (
      (record.phase === "installing" || record.phase === "installed") &&
      record.publishedIdentity &&
      sameIdentity(await fileIdentity(record.destination ?? target), record.publishedIdentity)
    ) {
      if (kind !== "rename" && (await fileRevision(target)) !== record.desired)
        return finish("attention", "recovery");
      return finish("done");
    }
    if (
      record.phase === "restoring" &&
      record.failure &&
      sameIdentity(
        await fileIdentity(target),
        await fileIdentity(record.publication === "exchange" ? slot : retained),
      )
    )
      return finish("attention", record.failure);
    return finish("attention", "recovery");
  }
  if (record.phase === "preparing") {
    const space = await NodeFSP.statfs(directory, { bigint: true });
    const capturedBytes = await NodeFSP.lstat(target).then(
      (stat) => stat.size,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return 0;
        throw e;
      },
    );
    const required = BigInt(input.bytes?.byteLength ?? 0) + BigInt(capturedBytes) + 16384n;
    if (
      space.bavail * space.bsize < required ||
      (input.retentionLimitBytes != null &&
        (await retainedStorageBytes(input.retentionDirectory)) + Number(required) >
          input.retentionLimitBytes)
    )
      throw new RetainedMutationError(
        "unavailable",
        "Retained storage cannot admit this mutation without deleting unresolved versions.",
        input.id,
      );
    if (record.desired !== null) {
      if ((await fileIdentity(slot)) === null) {
        if (input.bytes == null) return finish("skipped", "unavailable");
        const mode = record.publication === "create" ? (record.executable ? 0o777 : 0o666) : 0o600;
        const handle = await NodeFSP.open(slot, "wx", mode);
        try {
          await handle.writeFile(input.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(directory);
      }
      if ((await fileRevision(slot)) !== record.desired) return finish("attention", "recovery");
      await point("staged");
      await save({ stagedIdentity: await fileIdentity(slot) });
    }
    await save({ phase: "prepared" });
    await point("prepared");
  }
  if (
    record.desired !== null &&
    (!sameIdentity(await fileIdentity(slot), record.stagedIdentity) ||
      (await fileRevision(slot)) !== record.desired)
  )
    return finish("attention", "recovery");
  if (record.publication === "create") {
    await save({
      phase: "publishing",
      publishedIdentity: null,
      publishedRevision: null,
      sourceMutation: true,
    });
    await point("checked");
    await point("install-intent");
    const reply = await command("create", "slot", NodePath.basename(target));
    if (reply.outcome === "unchanged") {
      await save({ sourceMutation: false });
      return finish("skipped", reply.code === 17 ? "exists" : "unavailable");
    }
    if (reply.destinationAfter) await save({ publishedIdentity: reply.destinationAfter });
    if (
      !good(reply) ||
      !record.publishedIdentity ||
      sameIdentity(record.publishedIdentity, record.stagedIdentity) ||
      !sameIdentity(reply.sourceBefore, record.stagedIdentity) ||
      !sameIdentity(reply.sourceAfter, record.stagedIdentity)
    )
      return finish("attention", "recovery");
    await save({ phase: "installed", publishedRevision: record.desired });
    await point("installed");
    if (
      !sameIdentity(await fileIdentity(target), record.publishedIdentity) ||
      (await fileRevision(target)) !== record.desired
    )
      return finish("attention", "recovery");
    return finish("done");
  }
  if (kind === "write") {
    await save({ phase: "publishing", sourceMutation: true });
    await point("checked");
    const reply = await command("exchange", "slot", NodePath.basename(target));
    if (reply.outcome === "unchanged") {
      await save({ sourceMutation: false });
      return finish("skipped", "target");
    }
    if (reply.outcome !== "applied") return finish("attention", "recovery");
    await save({ phase: "displaced", capturedIdentity: reply.sourceAfter });
    await point("displaced");
    if (!sameIdentity(await fileIdentity(slot), record.capturedIdentity))
      return finish("attention", "recovery");
    if (!(await regular(slot))) return compensateExchange("target");
    if (!(await guarded(slot))) return compensateExchange("revision");
    if (
      !good(reply) ||
      !sameIdentity(reply.destinationAfter, record.stagedIdentity) ||
      !sameIdentity(await fileIdentity(target), record.stagedIdentity)
    )
      return finish("attention", "recovery");
    await save({ publishedIdentity: record.stagedIdentity, publishedRevision: record.desired });
    await point("installed");
    return finish("done");
  }
  await save({ phase: "publishing", sourceMutation: true });
  await point("checked");
  const capture = await command("capture", NodePath.basename(target), "retained");
  if (capture.outcome === "unchanged") {
    await save({ sourceMutation: false });
    return finish("skipped", "target");
  }
  if (!good(capture)) return finish("attention", "recovery");
  await save({ phase: "displaced", capturedIdentity: capture.destinationAfter });
  await point("displaced");
  if (
    kind !== "prune" &&
    (await regular(retained)) &&
    !sameIdentity(await fileIdentity(retained), record.capturedIdentity)
  )
    return finish("attention", "recovery");
  if (kind === "prune") {
    const stat = await NodeFSP.lstat(retained);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await NodeFSP.readdir(retained)).length !== 0
    ) {
      await save({ phase: "restoring", failure: "target" });
      const restored = await command("restore", "retained", NodePath.basename(target));
      return finish("attention", good(restored) ? "target" : "recovery");
    }
    const removed = await command("rmdir", "retained", "retained");
    return good(removed) ? finish("done") : finish("attention", "recovery");
  }
  if (!(await regular(retained))) return restoreCaptured("retained", "target");
  if (!(await guarded(retained))) return restoreCaptured("retained", "revision");
  if (kind === "delete") return finish("done");
  if (!record.destination || !input.destinationBinding) return finish("attention", "recovery");
  const revision = await leadingFileRevision(retained);
  await save({
    phase: "installing",
    publishedIdentity: record.capturedIdentity,
    publishedRevision: revision,
  });
  await point("install-intent");
  const published = await command(
    "link",
    "retained",
    NodePath.basename(record.destination),
    input.destinationBinding,
  );
  if (!good(published)) {
    if (published.outcome === "unchanged") return restoreCaptured("retained", "exists");
    return finish("attention", "recovery");
  }
  await point("installed");
  if (
    !sameIdentity(published.destinationAfter, record.capturedIdentity) ||
    !sameIdentity(await fileIdentity(record.destination), record.capturedIdentity)
  )
    return finish("attention", "recovery");
  await save({ phase: "installed" });
  return finish("done");
}

/** Late handles remain observable; neither completion nor matching bytes authorize deletion. */
export async function recheckRetainedFile(
  result: RetainedMutationResult,
  expectedRevision: string | null,
) {
  const revision = result.retainedPath ? await fileRevision(result.retainedPath) : null;
  return { ...result, retainedRevision: revision, changed: revision !== expectedRevision };
}
export const decodeCurrentRetainedRecord = decodeCurrent;

/** The view name is fixed by the server; a hardlink retains the very same late-writable object. */
export async function retainedViewPath(
  directory: string,
  leaf: (typeof retainedFileNames)[number],
  target: string,
) {
  await assertPrivateRetention(directory);
  const source = NodePath.join(directory, leaf),
    identity = await fileIdentity(source);
  if (!identity) return source;
  const extension = NodePath.extname(target);
  const safeExtension = /^\.[a-zA-Z0-9]{1,16}$/u.test(extension) ? extension : ".txt";
  const view = NodePath.join(directory, `view-${leaf}${safeExtension}`);
  try {
    await NodeFSP.link(source, view);
    await syncDirectory(directory);
  } catch (e) {
    if (!isRetainedExists(e) || !sameIdentity(await fileIdentity(view), identity)) throw e;
  }
  return view;
}

function isRetainedExists(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e && e.code === "EEXIST";
}

function isRetainedMissing(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

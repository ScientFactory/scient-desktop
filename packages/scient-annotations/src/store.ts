// @effect-diagnostics nodeBuiltinImport:off -- This is the document annotation filesystem boundary.
// @effect-diagnostics globalDate:off -- Interoperable durable provenance timestamps.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";
import { withMaterialBudget } from "./materialBudget.ts";
import {
  AnnotationCommand,
  AnnotationCommit,
  AnnotationRecord,
  DocumentResource,
  Id,
  type AnnotationMutation,
} from "./model.ts";

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_MATERIAL_BYTES = 100 * 1024 * 1024;
const MAX_ANNOTATIONS = 10_000;
const MAX_REVISIONS = 10_000;
const STORE = ".scient/evidence/v1";

const decodeCommand = Schema.decodeUnknownSync(AnnotationCommand);
const decodeCommit = Schema.decodeUnknownSync(AnnotationCommit);
const decodeRecord = Schema.decodeUnknownSync(AnnotationRecord);
const decodeResource = Schema.decodeUnknownSync(DocumentResource);
const decodeId = Schema.decodeUnknownSync(Id);
const isId = Schema.is(Id);
const hash = (data: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");
const encode = (data: unknown) => JSON.stringify(data);

export class AnnotationStoreError extends Error {
  readonly reason:
    | "scope-changed"
    | "unsafe-path"
    | "corrupt"
    | "material-changed"
    | "capacity"
    | "operation-reused";
  constructor(
    reason:
      | "scope-changed"
      | "unsafe-path"
      | "corrupt"
      | "material-changed"
      | "capacity"
      | "operation-reused",
    message: string,
  ) {
    super(message);
    this.reason = reason;
    this.name = "AnnotationStoreError";
  }
}

/** Not portable authority: a copied logical project ID is deliberately insufficient. */
export interface AnnotationScope {
  readonly root: string;
  readonly projectId: string;
  readonly workspaceBinding: string;
  readonly principal: string;
  readonly generation: string;
}

/**
 * A host supplies a current-authority check and a publication fence coordinated
 * with its revocations. The core cannot infer access from an actor string.
 */
export interface AnnotationAuthority {
  readonly principal: string;
  readonly generation: string;
  readonly check: () => Promise<void>;
  readonly publish: <A>(operation: () => Promise<A>) => Promise<A>;
}

export interface AnnotationStoreHooks {
  readonly at?: (point: "retained" | "staged" | "published") => Promise<void>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function scopeFor(root: string, authority: AnnotationAuthority): Promise<AnnotationScope> {
  await authority.check();
  const canonical = await NodeFSP.realpath(root);
  const stats = await NodeFSP.stat(canonical, { bigint: true });
  const identity = await readScientProjectIdentity(canonical);
  return {
    root: canonical,
    projectId: identity.projectId,
    workspaceBinding: hash(
      encode([canonical, stats.dev.toString(), stats.ino.toString(), identity]),
    ),
    principal: authority.principal,
    generation: hash(authority.generation),
  };
}

/** Every component under the owner must be a real directory, never a symlink. */
async function safeDirectory(root: string, relative: string, create: boolean): Promise<string> {
  let current = root;
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === ".." || part.includes("\\"))
      throw new AnnotationStoreError("unsafe-path", "Invalid annotation directory.");
    current = NodePath.join(current, part);
    if (create) {
      try {
        await NodeFSP.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!isExists(error)) throw error;
      }
    }
    const stat = await NodeFSP.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AnnotationStoreError("unsafe-path", "Annotation storage must not traverse links.");
  }
  return current;
}

async function readBytes(file: string, limit: number): Promise<Uint8Array> {
  const handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new AnnotationStoreError("capacity", "The file is not a bounded regular file.");
    // Bound the allocation/read even if another process grows the file after stat().
    const buffer = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (part.bytesRead === 0) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead !== stat.size)
      throw new AnnotationStoreError("material-changed", "The file changed while it was read.");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(Buffer.from(await readBytes(file, MAX_RECORD_BYTES)).toString("utf8"));
  } catch (error) {
    if (isMissing(error) || error instanceof AnnotationStoreError) throw error;
    throw new AnnotationStoreError(
      "corrupt",
      "An annotation record is unreadable; it was preserved.",
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, NodeFS.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Same-directory staging + no-replace publication is the cross-process CAS. */
async function publishFile(
  directory: string,
  name: string,
  bytes: Uint8Array | string,
  publish: AnnotationAuthority["publish"],
  before?: () => Promise<void>,
): Promise<boolean> {
  const temporary = NodePath.join(directory, ".stage-" + NodeCrypto.randomUUID());
  const target = NodePath.join(directory, name);
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await before?.();
    return await publish(async () => {
      try {
        await NodeFSP.link(temporary, target);
      } catch (error) {
        if (isExists(error)) return false;
        throw error;
      }
      await syncDirectory(directory);
      return true;
    });
  } finally {
    await NodeFSP.unlink(temporary).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export async function openAnnotationStore(
  root: string,
  authority: AnnotationAuthority,
  hooks: AnnotationStoreHooks = {},
) {
  const scope = await scopeFor(root, authority);
  const owner = { kind: "project" as const, projectId: scope.projectId };
  async function check() {
    const current = await scopeFor(root, authority);
    if (
      current.workspaceBinding !== scope.workspaceBinding ||
      current.generation !== scope.generation ||
      current.principal !== scope.principal
    )
      throw new AnnotationStoreError(
        "scope-changed",
        "Reopen this document in its current workspace.",
      );
  }
  const publish: AnnotationAuthority["publish"] = (run) =>
    authority.publish(async () => {
      await check();
      return run();
    });
  const directory = (suffix: string, create = false) =>
    safeDirectory(scope.root, STORE + (suffix ? "/" + suffix : ""), create);

  async function resourceFor(
    relativePath: string,
    create = false,
  ): Promise<DocumentResource | null> {
    await check();
    const normalized = relativePath.replaceAll("\\", "/");
    if (
      NodePath.isAbsolute(relativePath) ||
      normalized.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new AnnotationStoreError("unsafe-path", "Choose a file inside this project.");
    const name = hash(normalized) + ".json";
    let dir: string;
    try {
      dir = await directory("resources", create);
    } catch (error) {
      if (!create && isMissing(error)) return null;
      throw error;
    }
    try {
      const resource = decodeResource(await readJson(NodePath.join(dir, name)));
      if (resource.owner.projectId !== scope.projectId || resource.locator !== normalized)
        throw new AnnotationStoreError("corrupt", "Resource identity does not match its owner.");
      return resource;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!create) return null;
    const resource = decodeResource({
      formatVersion: 1,
      resourceId: NodeCrypto.randomUUID(),
      owner,
      locator: normalized,
    });
    await publishFile(dir, name, encode(resource), publish);
    // A simultaneous registration owns the same stable resource, not a second ID.
    return resourceFor(normalized);
  }

  async function resourceById(resourceId: string): Promise<DocumentResource> {
    decodeId(resourceId);
    const dir = await directory("resources");
    const names = (await NodeFSP.readdir(dir)).filter((n) => /^[a-f0-9]{64}\.json$/u.test(n));
    if (names.length > MAX_ANNOTATIONS)
      throw new AnnotationStoreError("capacity", "Resource limit reached.");
    for (const name of names) {
      const resource = decodeResource(await readJson(NodePath.join(dir, name)));
      if (resource.resourceId === resourceId && resource.owner.projectId === scope.projectId)
        return resource;
    }
    throw new AnnotationStoreError("corrupt", "This resource does not belong to this project.");
  }

  async function commitDirectory(id: string, create = false) {
    return directory("annotations/" + decodeId(id), create);
  }
  async function history(id: string): Promise<readonly AnnotationCommit[]> {
    await check();
    decodeId(id);
    const imported = await importedCommit(id);
    let dir: string;
    try {
      dir = await commitDirectory(id);
    } catch (error) {
      if (isMissing(error)) return imported ? [imported] : [];
      throw error;
    }
    const names = (await NodeFSP.readdir(dir)).filter((n) => /^[0-9]{8}\.json$/u.test(n)).sort();
    if (names.length > MAX_REVISIONS)
      throw new AnnotationStoreError("capacity", "Annotation history is over its safe limit.");
    const commits: AnnotationCommit[] = imported ? [imported] : [];
    for (const name of names) {
      const commit = decodeCommit(await readJson(NodePath.join(dir, name)));
      const previous = commits.at(-1);
      if (
        commit.record.annotationId !== id ||
        commit.record.owner.projectId !== scope.projectId ||
        commit.record.revision !== (previous?.record.revision ?? 0) + 1 ||
        name !== String(commit.record.revision).padStart(8, "0") + ".json" ||
        commit.operation.previousRevision !== (previous?.record.revision ?? 0) ||
        commit.operation.operationId !== commit.command.operationId ||
        commit.operation.requestHash !== hash(encode(commit.command)) ||
        (previous && encode(commit.record.region) !== encode(previous.record.region))
      )
        throw new AnnotationStoreError(
          "corrupt",
          "Annotation history is inconsistent; nothing was rewritten.",
        );
      commits.push(commit);
    }
    await check();
    return commits;
  }

  async function list(resourceId?: string): Promise<readonly AnnotationRecord[]> {
    await check();
    let names: string[] = [];
    try {
      names = await NodeFSP.readdir(await directory("annotations"));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const ids = [
      ...new Set([
        ...names.filter((id) => isId(id)),
        ...((await importedRecords()) ?? []).map((c) => c.record.annotationId),
      ]),
    ];
    if (ids.length > MAX_ANNOTATIONS)
      throw new AnnotationStoreError("capacity", "Annotation limit reached.");
    const result: AnnotationRecord[] = [];
    for (const id of ids) {
      const latest = (await history(id)).at(-1)?.record;
      if (latest && (!resourceId || latest.region.resourceId === resourceId)) result.push(latest);
    }
    await check();
    return result;
  }

  const retain = (resource: DocumentResource, capture: AnnotationRecord["region"]["capture"]) =>
    withMaterialBudget(() => retainMaterial(resource, capture));
  async function retainMaterial(
    resource: DocumentResource,
    capture: AnnotationRecord["region"]["capture"],
  ) {
    const { material } = capture;
    const dir = await directory("materials", true);
    const name = material.sha256 + ".pdf";
    const absolute = await NodeFSP.realpath(NodePath.join(scope.root, resource.locator));
    const relative = NodePath.relative(scope.root, absolute);
    if (
      !relative ||
      relative.startsWith(".." + NodePath.sep) ||
      relative === ".." ||
      NodePath.isAbsolute(relative)
    )
      throw new AnnotationStoreError("unsafe-path", "This PDF resolves outside its project.");
    const bytes = await readBytes(absolute, MAX_MATERIAL_BYTES);
    if (
      bytes.byteLength !== material.byteLength ||
      hash(bytes) !== material.sha256 ||
      !Buffer.from(bytes.subarray(0, 1_024)).includes(Buffer.from("%PDF-"))
    )
      throw new AnnotationStoreError(
        "material-changed",
        "The PDF changed. Reload it before saving an annotation.",
      );
    try {
      const existing = await readBytes(NodePath.join(dir, name), MAX_MATERIAL_BYTES);
      if (existing.byteLength !== material.byteLength || hash(existing) !== material.sha256)
        throw new AnnotationStoreError("corrupt", "Retained PDF integrity check failed.");
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await publishFile(dir, name, bytes, publish);
    await hooks.at?.("retained");
  }

  async function mutate(input: AnnotationCommand, locator?: string): Promise<AnnotationMutation> {
    const command = decodeCommand(input);
    await check();
    const commits = await history(command.annotationId);
    const current = commits.at(-1)?.record ?? null;
    const requestHash = hash(encode(command));
    const replay = commits.find((c) => c.operation.operationId === command.operationId);
    if (replay) {
      if (
        replay.operation.requestHash !== requestHash ||
        replay.operation.workspaceBinding !== scope.workspaceBinding ||
        replay.operation.generation !== scope.generation ||
        replay.operation.principal !== scope.principal
      )
        throw new AnnotationStoreError(
          "operation-reused",
          "This operation cannot be replayed with different content or authority.",
        );
      return { outcome: "replayed", record: replay.record };
    }
    if (
      command.action === "create"
        ? current !== null
        : current?.revision !== command.expectedRevision
    )
      return { outcome: current ? "conflict" : "not-found", record: current };
    if (command.action !== "create" && !current) return { outcome: "not-found", record: null };
    if (current?.deletedAt && command.action !== "restore")
      return { outcome: "conflict", record: current };
    if (commits.length >= MAX_REVISIONS)
      throw new AnnotationStoreError(
        "capacity",
        "Annotation history limit reached. No history was discarded.",
      );
    const now = new Date().toISOString();
    const record = decodeRecord(
      command.action === "create"
        ? {
            formatVersion: 1,
            annotationId: command.annotationId,
            revision: 1,
            owner,
            bodyFormat: "plain-text",
            region: {
              regionId: NodeCrypto.randomUUID(),
              resourceId: command.resourceId,
              capture: command.capture,
            },
            note: command.note,
            highlighted: command.highlighted,
            correctedText: null,
            authorship: { kind: "user", principal: scope.principal },
            review: { state: "accepted", principal: scope.principal },
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }
        : {
            ...current,
            revision: current!.revision + 1,
            updatedAt: now,
            ...(command.action === "edit"
              ? {
                  note: command.note,
                  highlighted: command.highlighted,
                  ...(command.correctedText !== undefined
                    ? {
                        correctedText:
                          command.correctedText === null
                            ? null
                            : { text: command.correctedText, author: scope.principal },
                      }
                    : {}),
                }
              : { deletedAt: command.action === "remove" ? now : null }),
          },
    );
    if (command.action === "create") {
      const resource = locator
        ? await resourceFor(locator)
        : await resourceById(command.resourceId);
      if (!resource || resource.resourceId !== command.resourceId)
        throw new AnnotationStoreError(
          "unsafe-path",
          "This document is not the requested resource.",
        );
      await retain(resource, command.capture);
    }
    const commit = decodeCommit({
      formatVersion: 1,
      command,
      record,
      operation: {
        operationId: command.operationId,
        requestHash,
        principal: scope.principal,
        workspaceBinding: scope.workspaceBinding,
        generation: scope.generation,
        committedAt: now,
        previousRevision: current?.revision ?? 0,
      },
    });
    const bytes = encode(commit);
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
      throw new AnnotationStoreError("capacity", "The annotation exceeds its safe record size.");
    const dir = await commitDirectory(command.annotationId, true);
    const won = await publishFile(
      dir,
      String(record.revision).padStart(8, "0") + ".json",
      bytes,
      publish,
      () => hooks.at?.("staged") ?? Promise.resolve(),
    );
    if (!won) return mutate(command, locator); // Reload: exact replay or an explicit CAS conflict.
    await hooks.at?.("published");
    await check(); // An uncertain/lost response is reconciled by the durable operation.
    return { outcome: "committed", record };
  }

  async function retainedMaterial(annotationId: string): Promise<string> {
    const record = (await history(annotationId)).at(-1)?.record;
    if (!record) throw new AnnotationStoreError("corrupt", "Annotation not found.");
    const file = NodePath.join(
      await directory("materials"),
      record.region.capture.material.sha256 + ".pdf",
    );
    const bytes = await readBytes(file, MAX_MATERIAL_BYTES);
    if (
      bytes.byteLength !== record.region.capture.material.byteLength ||
      hash(bytes) !== record.region.capture.material.sha256
    )
      throw new AnnotationStoreError("corrupt", "Retained material is unavailable or changed.");
    await check();
    return file;
  }

  /** Complete, one-time project import. Legacy snapshots remain untouched and inspectable. */
  async function importLegacy(input: {
    readonly snapshots: readonly { sourceId: string; content: string }[];
    readonly records: readonly AnnotationRecord[];
  }) {
    await check();
    if (input.records.length > MAX_ANNOTATIONS)
      throw new AnnotationStoreError("capacity", "Too many legacy annotations for this import.");
    const ids = new Set<string>();
    const snapshots = new Map(input.snapshots.map((s) => [decodeId(s.sourceId), s.content]));
    const records = input.records.map((raw) => {
      const record = decodeRecord(raw);
      if (
        ids.has(record.annotationId) ||
        record.owner.projectId !== scope.projectId ||
        record.authorship.kind !== "imported" ||
        record.review.state !== "imported" ||
        !record.importedFrom ||
        hash(snapshots.get(record.importedFrom.sourceId) ?? "") !==
          record.importedFrom.sourceSnapshotHash
      )
        throw new AnnotationStoreError(
          "corrupt",
          "Legacy annotation identity or provenance is inconsistent.",
        );
      ids.add(record.annotationId);
      return record;
    });
    async function agreesWithExisting() {
      const existing = await importedRecords();
      if (existing === null) return false;
      // A concurrent importer may allocate a different Region ID. The first complete
      // publication owns that ID; all captured data and source snapshots must still agree.
      const comparable = (record: AnnotationRecord) =>
        encode({
          ...record,
          region: { ...record.region, regionId: "allocated-at-publication" },
        });
      if (
        existing.length !== records.length ||
        records.some(
          (record) => !existing.some((commit) => comparable(commit.record) === comparable(record)),
        )
      )
        throw new AnnotationStoreError(
          "corrupt",
          "A different legacy import already exists. Originals were kept.",
        );
      const backup = await directory("imports/legacy-v1/sources");
      const names = (await NodeFSP.readdir(backup)).filter((name) => name.endsWith(".json"));
      if (names.length !== snapshots.size)
        throw new AnnotationStoreError(
          "corrupt",
          "Legacy backup inventory differs. Originals were kept.",
        );
      for (const [id, content] of snapshots) {
        if (
          Buffer.from(
            await readBytes(NodePath.join(backup, id + ".json"), 2 * 1024 * 1024),
          ).toString("utf8") !== content
        )
          throw new AnnotationStoreError("corrupt", "Legacy backup differs. Originals were kept.");
      }
      return true;
    }
    if (await agreesWithExisting())
      return { outcome: "already-imported" as const, count: records.length };
    for (const record of records) {
      if ((await history(record.annotationId)).length)
        throw new AnnotationStoreError(
          "corrupt",
          "A legacy annotation conflicts with an existing identity.",
        );
      await retain(await resourceById(record.region.resourceId), record.region.capture);
    }
    const dir = await directory("imports", true);
    const stage = NodePath.join(dir, ".stage-" + NodeCrypto.randomUUID());
    await NodeFSP.mkdir(stage, { mode: 0o700 });
    try {
      const now = new Date().toISOString();
      for (const record of records) {
        const command = {
          action: "import" as const,
          operationId: NodeCrypto.randomUUID(),
          annotationId: record.annotationId,
          sourceSnapshotHash: record.importedFrom!.sourceSnapshotHash,
        };
        const commit = decodeCommit({
          formatVersion: 1,
          command,
          record,
          operation: {
            operationId: command.operationId,
            requestHash: hash(encode(command)),
            principal: scope.principal,
            workspaceBinding: scope.workspaceBinding,
            generation: scope.generation,
            committedAt: now,
            previousRevision: 0,
          },
        });
        const bytes = encode(commit);
        if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
          throw new AnnotationStoreError(
            "capacity",
            "Legacy annotation exceeds its bounded record size.",
          );
        const handle = await NodeFSP.open(
          NodePath.join(stage, record.annotationId + ".json"),
          "wx",
          0o600,
        );
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const backupDir = NodePath.join(stage, "sources");
      await NodeFSP.mkdir(backupDir, { mode: 0o700 });
      for (const [id, content] of snapshots) {
        if (Buffer.byteLength(content) > 2 * 1024 * 1024)
          throw new AnnotationStoreError("capacity", "Legacy Source backup exceeds its safe size.");
        const handle = await NodeFSP.open(NodePath.join(backupDir, id + ".json"), "wx", 0o600);
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await syncDirectory(backupDir);
      await syncDirectory(stage);
      await hooks.at?.("staged");
      await publish(async () => {
        // A non-empty directory is never replaced by rename. Concurrent imports must agree.
        if (await agreesWithExisting()) return;
        try {
          await NodeFSP.rename(stage, NodePath.join(dir, "legacy-v1"));
        } catch (cause) {
          if (!(await agreesWithExisting())) throw cause;
        }
        await syncDirectory(dir);
      });
      await hooks.at?.("published");
      return { outcome: "imported" as const, count: records.length };
    } finally {
      // Only this operation's known, locally-created staging directory.
      await NodeFSP.rm(stage, { recursive: true, force: true });
    }
  }

  async function importedCommit(id: string): Promise<AnnotationCommit | null> {
    decodeId(id);
    let raw: unknown;
    try {
      raw = await readJson(NodePath.join(await directory("imports/legacy-v1"), id + ".json"));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const commit = decodeCommit(raw);
    if (
      commit.command.action !== "import" ||
      commit.record.annotationId !== id ||
      commit.record.owner.projectId !== scope.projectId ||
      commit.operation.previousRevision !== 0 ||
      commit.operation.requestHash !== hash(encode(commit.command))
    )
      throw new AnnotationStoreError("corrupt", "Legacy import is inconsistent; it was preserved.");
    return commit;
  }

  async function importedRecords(): Promise<readonly AnnotationCommit[] | null> {
    await check();
    let dir: string;
    try {
      dir = await directory("imports/legacy-v1");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const names = (await NodeFSP.readdir(dir)).filter((n) => n.endsWith(".json"));
    if (names.length > MAX_ANNOTATIONS)
      throw new AnnotationStoreError("capacity", "Legacy import exceeds its safe limit.");
    const records: AnnotationCommit[] = [];
    for (const name of names) {
      const id = decodeId(name.slice(0, -5));
      const commit = await importedCommit(id);
      if (!commit)
        throw new AnnotationStoreError("corrupt", "Legacy import changed during reading.");
      records.push(commit);
    }
    return records;
  }
  /**
   * An explicit move/reference-role handoff, not hash-based global identity.
   * The old Region/Annotation IDs are retained; a different existing identity is never merged.
   */
  async function aliasResource(input: {
    resourceId: string;
    relativePath: string;
    materialHash: string;
  }): Promise<DocumentResource> {
    await check();
    decodeId(input.resourceId);
    const owned = (await list(input.resourceId)).some(
      (record) => record.region.capture.material.sha256 === input.materialHash,
    );
    if (!owned)
      throw new AnnotationStoreError(
        "unsafe-path",
        "No owned annotation identifies this material revision.",
      );
    const normalized = input.relativePath.replaceAll("\\", "/");
    if (
      NodePath.isAbsolute(normalized) ||
      normalized.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new AnnotationStoreError("unsafe-path", "Choose a file inside this project.");
    const absolute = await NodeFSP.realpath(NodePath.join(scope.root, normalized));
    const relative = NodePath.relative(scope.root, absolute);
    if (
      relative === ".." ||
      relative.startsWith(".." + NodePath.sep) ||
      NodePath.isAbsolute(relative)
    )
      throw new AnnotationStoreError("unsafe-path", "This file resolves outside its project.");
    const bytes = await readBytes(absolute, MAX_MATERIAL_BYTES);
    if (hash(bytes) !== input.materialHash)
      throw new AnnotationStoreError(
        "material-changed",
        "This file is not the annotated PDF revision.",
      );
    const resource = decodeResource({
      formatVersion: 1,
      resourceId: input.resourceId,
      owner,
      locator: normalized,
    });
    const dir = await directory("resources", true);
    await publishFile(dir, hash(normalized) + ".json", encode(resource), publish);
    const committed = await resourceFor(normalized);
    if (!committed || committed.resourceId !== input.resourceId)
      throw new AnnotationStoreError(
        "operation-reused",
        "This path already identifies a different document.",
      );
    return committed;
  }

  async function retainedStorage() {
    await check();
    let dir: string;
    try {
      dir = await directory("materials");
    } catch (error) {
      if (isMissing(error)) return { revisions: 0, byteLength: 0 };
      throw error;
    }
    let byteLength = 0;
    let revisions = 0;
    for (const name of await NodeFSP.readdir(dir)) {
      if (!/^[a-f0-9]{64}\.pdf$/u.test(name)) continue;
      const stat = await NodeFSP.lstat(NodePath.join(dir, name));
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new AnnotationStoreError("unsafe-path", "Retention contains an unsafe file.");
      byteLength += stat.size;
      revisions++;
    }
    await check();
    return { revisions, byteLength };
  }
  return {
    scope,
    resourceFor,
    resourceById,
    history,
    list,
    mutate,
    retainedMaterial: (annotationId: string) =>
      withMaterialBudget(() => retainedMaterial(annotationId)),
    importLegacy,
    importedRecords,
    publish,
    aliasResource: (input: Parameters<typeof aliasResource>[0]) =>
      withMaterialBudget(() => aliasResource(input)),
    retainedStorage,
  };
}

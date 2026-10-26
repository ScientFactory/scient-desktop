// @effect-diagnostics nodeBuiltinImport:off
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  bytesRevision,
  durableJson,
  fileIdentity,
  fileRevision,
  inspectGuardedFile,
  peerEntry,
  holdsOnly,
  retainedPaths,
  retainedStorageBytes,
  readRetainedRecord,
  RetainedMutationError,
  type RetainedRefusal,
  type WindowsRetainedRecord,
  type RetainedMutationInput,
  type RetainedMutationResult,
  type RetainedMutationHooks,
  type MutationPoint,
} from "./RetainedFileMutation.ts";
import { windowsFileIdentity } from "./WindowsNativeFile.ts";
import type {
  NativeFileBinding,
  NativeFileIdentity,
  NativeFilePublicationLease,
  NativeFilePublicationRequest,
  NativeFilePublicationResult,
} from "./NativeFilePublication.ts";

const same = (a: NativeFileIdentity | null | undefined, b: NativeFileIdentity | null | undefined) =>
  !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const absent = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const good = (reply: NativeFilePublicationResult) =>
  reply.code === 0 &&
  reply.outcome === "applied" &&
  Object.values(reply.flush).every((value) => value <= 0);

/** Capture/install has a permission transition before its first namespace change. */
export async function runWindowsRetainedMutation(
  input: RetainedMutationInput & { binding: NativeFileBinding },
  target: string,
  directory: string,
  lease: NativeFilePublicationLease,
  hooks: RetainedMutationHooks,
): Promise<RetainedMutationResult> {
  const kind = input.kind ?? (input.bytes === null ? "delete" : "write");
  const condition = input.condition ?? (input.expectedRevision === null ? "absent" : "revision");
  const previous = await readRetainedRecord(directory).catch((error: unknown) => {
    if (!absent(error)) throw error;
    return null;
  });
  if (previous && !("originalSecurity" in previous))
    throw new RetainedMutationError(
      "recovery",
      "This record belongs to another file mechanism.",
      input.id,
    );
  const creation =
    kind === "create" ||
    condition === "absent" ||
    (kind === "write" && condition === "unguarded" && (await fileIdentity(target)) === null);
  let record: WindowsRetainedRecord = previous ?? {
    version: 2,
    mutationId: input.mutationId ?? input.id,
    target,
    ...(input.requestedPath ? { requestedPath: input.requestedPath } : {}),
    ...(input.requestedDestination ? { requestedDestination: input.requestedDestination } : {}),
    ...(input.expectedMutationEpoch ? { expectedMutationEpoch: input.expectedMutationEpoch } : {}),
    destination: input.destination ?? null,
    kind,
    condition,
    publication: creation
      ? "windows-stage-create"
      : kind === "write"
        ? "windows-move-install"
        : "windows-capture",
    expected: input.expectedRevision,
    desired: input.bytes == null ? null : bytesRevision(input.bytes),
    executable: input.executable ?? false,
    guardMaxBytes: input.guardMaxBytes ?? null,
    ...(input.peerGuards ? { peerGuards: input.peerGuards } : {}),
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
    sourceMutation: false,
    failure: null,
    visibleRetentionPath: input.visibleRetentionPath ?? null,
    retainedAt: await Effect.runPromise(Clock.currentTimeMillis),
    generation: 0,
    discarded: [],
    reviewedBinding: null,
    reviewedRevision: null,
    outcome: null,
    originalIdentity: null,
    stageName: `.scient-overleaf-apply-${NodeCrypto.randomUUID()}`,
    originalSecurity: "original-security",
    originalDescriptor: null,
  };
  if (
    record.target !== target ||
    record.mutationId !== (input.mutationId ?? input.id) ||
    record.kind !== kind ||
    record.condition !== condition ||
    record.expected !== input.expectedRevision ||
    record.destination !== (input.destination ?? null) ||
    record.executable !== (input.executable ?? false) ||
    record.guardMaxBytes !== (input.guardMaxBytes ?? null) ||
    (record.expectedMutationEpoch ?? null) !== (input.expectedMutationEpoch ?? null) ||
    JSON.stringify(record.peerGuards ?? []) !== JSON.stringify(input.peerGuards ?? []) ||
    (input.bytes !== undefined &&
      record.desired !== (input.bytes === null ? null : bytesRevision(input.bytes)))
  )
    throw new RetainedMutationError(
      "intent",
      "Retained mutation id was reused with a different intent.",
      input.id,
    );
  const save = async (patch: Partial<WindowsRetainedRecord>) => {
    lease.assertHeld();
    record = { ...record, ...patch, generation: record.generation + 1 };
    await durableJson(NodePath.join(directory, "record.json"), record);
  };
  const point = async (name: MutationPoint) => {
    lease.assertHeld();
    await hooks.at?.(name);
    lease.assertHeld();
  };
  const result = async (): Promise<RetainedMutationResult> => {
    const paths = await retainedPaths(directory);
    const kept = paths.find((path) => NodePath.basename(path) === "retained") ?? null;
    return {
      outcome: record.outcome ?? "attention",
      recordDirectory: directory,
      retainedPath: kept,
      retainedPaths: paths,
      retainedRevision: kept ? await fileRevision(kept) : null,
      retainedIdentity: kept ? await fileIdentity(kept) : null,
      mutationId: record.mutationId,
      revision: record.publishedRevision,
      currentRevision: record.currentRevision,
      failure: record.failure,
      sourceMutation: record.sourceMutation ?? false,
      ...(record.publicationEpoch ? { publicationEpoch: record.publicationEpoch } : {}),
    };
  };
  const finish = async (
    outcome: RetainedMutationResult["outcome"],
    failure: WindowsRetainedRecord["failure"] = null,
  ) => {
    await save({ phase: "done", outcome, failure });
    await point("done");
    return result();
  };
  if (record.phase === "done") return result();
  const bindingSame = (a: NativeFileBinding | null, b: NativeFileBinding | undefined) =>
    !!a &&
    !!b &&
    a.rootPath === b.rootPath &&
    a.parentRelativePath === b.parentRelativePath &&
    a.recordPath === b.recordPath &&
    same(a.rootIdentity, b.rootIdentity) &&
    same(a.parentIdentity, b.parentIdentity) &&
    same(a.recordIdentity, b.recordIdentity);
  if (
    !bindingSame(record.binding, input.binding) ||
    (record.destination && !bindingSame(record.destinationBinding, input.destinationBinding))
  )
    return finish("attention", "target");
  const stage = NodePath.join(NodePath.dirname(target), record.stageName);
  const retained = NodePath.join(directory, "retained");
  const published = record.destination ?? target;
  let stageRevision =
    record.kind === "rename" ? (record.currentRevision ?? record.expected) : record.desired;
  const command = (
    operation: NativeFilePublicationRequest["operation"],
    source = NodePath.basename(target),
    destination = record.stageName,
    binding = input.binding,
  ) => lease.run({ operation, sourceName: source, destinationName: destination, binding });
  const peersIntact = async () => {
    const planned = new Set([
      NodePath.relative(input.cwd, target).replaceAll(NodePath.sep, "/"),
      ...(record.peerGuards ?? []).map((peer) => peer.path),
    ]);
    for (const peer of record.peerGuards ?? []) {
      const entry = await peerEntry(input.cwd, peer.path, planned);
      if (peer.revision !== null) {
        if (entry.kind !== "file" || entry.revision !== peer.revision) return false;
      } else if (entry.kind === "directory") {
        if (!peer.directory || (peer.only && !(await holdsOnly(input.cwd, peer.path, peer.only))))
          return false;
      } else if (entry.kind !== "absent") return false;
    }
    return true;
  };
  const settlePrune = async () => {
    const removed = await command("win-remove-captured");
    if (good(removed)) return finish("done");
    await save({ phase: "restoring", failure: "target" });
    const restored = await command("win-return-captured", "retained", NodePath.basename(target));
    if (!good(restored)) return result();
    const policy = await command("win-restore-policy");
    return good(policy) ? finish("attention", "target") : result();
  };
  let held = false;
  try {
    if (previous && record.phase !== "preparing") {
      const current =
        kind === "prune" ? await windowsFileIdentity(target) : await fileIdentity(target);
      const kept =
        kind === "prune" ? await windowsFileIdentity(retained) : await fileIdentity(retained);
      const staged = await fileIdentity(stage);
      if (same(await fileIdentity(published), record.stagedIdentity) && staged === null) {
        if (
          record.publication !== "windows-stage-create" &&
          (!same(kept, record.originalIdentity) ||
            (await fileRevision(retained)) !== (record.currentRevision ?? record.expected))
        )
          return finish("attention", "recovery");
        if ((await fileRevision(published)) !== stageRevision)
          return finish("attention", "recovery");
        await save({ publishedIdentity: record.stagedIdentity, publishedRevision: stageRevision });
        return finish("done");
      }
      if (same(current, record.originalIdentity) && kept === null) {
        const reply = await command("win-resume");
        held = true;
        // Delete has no stage; its original is still opened even if resume reports absent staging.
        if (!same(reply.sourceBefore, record.originalIdentity))
          return finish("attention", "recovery");
        if (
          !record.originalDescriptor ||
          (await NodeFSP.readFile(NodePath.join(directory, "original-security"))).toString(
            "base64",
          ) !== record.originalDescriptor
        )
          return result();
        const restored = await command("win-restore-policy");
        if (!good(restored)) return result();
        await save({ sourceMutation: false, currentRevision: await fileRevision(target) });
        return finish("skipped", "revision");
      }
      if (
        kind === "prune" &&
        kept === null &&
        record.phase === "displaced" &&
        record.capturedIdentity
      )
        return finish("done");
      if (record.publication !== "windows-stage-create") {
        if (
          !same(kept, record.originalIdentity) ||
          (kind !== "prune" &&
            (await fileRevision(retained)) !== (record.currentRevision ?? record.expected))
        )
          return finish("attention", "recovery");
        await save({ capturedIdentity: record.originalIdentity, sourceMutation: true });
        if (kind === "prune") {
          const resumed = await command("win-resume-captured", "retained");
          held = true;
          if (resumed.code !== 0 || !same(resumed.sourceBefore, record.originalIdentity))
            return result();
          return settlePrune();
        }
        if (kind === "delete")
          return finish(
            current === null ? "done" : "attention",
            current === null ? null : "recovery",
          );
      }
      if (
        (await NodeFSP.lstat(published).then(
          () => true,
          (error: unknown) => {
            if (!absent(error)) throw error;
            return false;
          },
        )) ||
        !same(staged, record.stagedIdentity) ||
        (await fileRevision(stage)) !== stageRevision ||
        !(await peersIntact())
      )
        return finish("attention", "recovery");
      if (
        record.expectedMutationEpoch &&
        input.bytes === undefined &&
        (record.sourceMutation === false || record.publication === "windows-stage-create")
      )
        return finish("skipped", "revision");
      const resumed = await command("win-resume-stage");
      held = true;
      if (
        resumed.code !== 0 ||
        !same(resumed.destinationAfter, record.stagedIdentity) ||
        (await fileRevision(stage)) !== stageRevision
      )
        return finish("attention", "recovery");
    } else {
      if (previous) return finish("skipped", "unavailable");
      await save({});
      await point("intent");
      if (!(await peersIntact())) return finish("skipped", "revision");
      if (
        creation &&
        (await NodeFSP.lstat(target).then(
          () => true,
          (error: unknown) => {
            if (!absent(error)) throw error;
            return false;
          },
        ))
      )
        return finish("skipped", "exists");
      const space = await NodeFSP.statfs(directory, { bigint: true });
      const required = BigInt(input.bytes?.byteLength ?? 0) + 16384n;
      if (
        space.bavail * space.bsize < required ||
        (input.retentionLimitBytes != null &&
          (await retainedStorageBytes(input.retentionDirectory)) + Number(required) >
            input.retentionLimitBytes)
      )
        throw new RetainedMutationError(
          "unavailable",
          "Retained storage cannot admit this mutation.",
          input.id,
        );
      if (
        record.destination &&
        (await NodeFSP.lstat(record.destination).then(
          () => true,
          (error: unknown) => {
            if (!absent(error)) throw error;
            return false;
          },
        ))
      )
        return finish("skipped", "exists");
      if (kind === "rename" && stageRevision === null) {
        stageRevision = await fileRevision(target);
        if (!stageRevision) return finish("skipped", "target");
        await save({ currentRevision: stageRevision });
      }
      if (stageRevision !== null) {
        const payload = await NodeFSP.open(NodePath.join(directory, "payload"), "wx", 0o600);
        try {
          await payload.writeFile(
            kind === "rename" ? await NodeFSP.readFile(target) : input.bytes!,
          );
          await payload.sync();
        } finally {
          await payload.close();
        }
      }
      const prepared = await command(
        creation
          ? "win-prepare-create"
          : stageRevision === null
            ? "win-prepare-delete"
            : "win-prepare",
      );
      held = true;
      if (prepared.code !== 0 && prepared.outcome !== "unchanged") return result();
      if (prepared.code !== 0) {
        const reasons: Partial<Record<number, RetainedRefusal>> = {
          32: "file-busy",
          33: "file-busy",
          536870919: "online-only-file",
          536870914: "encrypted-file",
          536870915: "multiple-hard-links",
          536870916: "alternate-data-streams",
        };
        throw new RetainedMutationError(
          "unavailable",
          reasons[prepared.code] ?? `Windows file preparation refused (${prepared.code}).`,
          input.id,
          [],
          reasons[prepared.code] ? { refusal: reasons[prepared.code]! } : undefined,
        );
      }
      await save({
        originalIdentity: prepared.sourceBefore,
        stagedIdentity: prepared.destinationAfter,
        originalDescriptor: prepared.sourceBefore
          ? (await NodeFSP.readFile(NodePath.join(directory, "original-security"))).toString(
              "base64",
            )
          : null,
      });
      await point("staged");
      if (stageRevision !== null && (await fileRevision(stage)) !== stageRevision)
        return finish("attention", "recovery");
      await save({ phase: "prepared" });
      await point("prepared");
      if (!creation) {
        const snapshot =
          kind === "prune" ? null : await inspectGuardedFile(target, input.guardMaxBytes);
        if (
          kind !== "prune" &&
          (!snapshot ||
            !same(snapshot.identity, record.originalIdentity) ||
            (condition === "revision" && snapshot.revision !== record.expected) ||
            (kind === "rename" && snapshot.revision !== stageRevision) ||
            (input.guardMaxBytes !== undefined &&
              (snapshot.byteLength > input.guardMaxBytes || snapshot.binary)))
        )
          return finish("skipped", "revision");
        await save({ currentRevision: snapshot?.revision ?? null });
      }
      if (!(await peersIntact())) return finish("skipped", "revision");
      if (kind === "prune" && (await NodeFSP.readdir(target)).length)
        return finish("skipped", "target");
      await save({
        phase: "publishing",
        sourceMutation: true,
        ...(record.expectedMutationEpoch ? { publicationEpoch: record.expectedMutationEpoch } : {}),
      });
      await point("checked");
      if (!creation) {
        const restricted = await command("win-restrict");
        if (!good(restricted)) return result();
        await point("restricted");
        const captured = await command("win-capture", NodePath.basename(target), "retained");
        await point("called");
        if (!good(captured) || !same(captured.destinationAfter, record.originalIdentity))
          return result();
        await save({ phase: "displaced", capturedIdentity: record.originalIdentity });
        await point("displaced");
      }
    }
    if (kind === "delete") return finish("done");
    if (kind === "prune") {
      return settlePrune();
    }
    await save({ phase: "installing", sourceMutation: true });
    await point("install-intent");
    const installed = await command(
      "win-install",
      record.stageName,
      NodePath.basename(published),
      input.destinationBinding ?? input.binding,
    );
    await command("win-release");
    held = false;
    await point("called");
    if (!good(installed)) return finish("attention", "recovery");
    await save({
      phase: "installed",
      publishedIdentity: record.stagedIdentity,
      publishedRevision: stageRevision,
    });
    await point("installed");
    if (
      !same(await fileIdentity(published), record.stagedIdentity) ||
      (await fileRevision(published)) !== stageRevision
    )
      return finish("attention", "recovery");
    return finish("done");
  } finally {
    if (held) await command("win-release");
  }
}

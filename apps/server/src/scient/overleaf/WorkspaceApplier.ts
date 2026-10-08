// @effect-diagnostics nodeBuiltinImport:off
/** Local application only: no network, editor authority, or publication entry point. */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import {
  bytesRevision,
  directoryIdentity,
  assertRootBinding,
  syncDirectory,
  decodeRetainedRecord,
  durableJson,
  fileRevision,
  fileIdentity,
  recheckRetainedFile,
  type RetainedMutationResult,
} from "../workspace/RetainedFileMutation.ts";
import { manuscriptCollisionKey } from "./unicodeCaseFold.ts";
import { manuscriptTreeProblem, manuscriptPathProblem } from "./manuscriptPaths.ts";
import {
  advanceBase,
  applyUnits,
  closeOverRenames,
  hasConflictMarkers,
  type ConflictGroup,
  type FileChange,
  type Rename,
} from "./syncRules.ts";

const StringMap = Schema.Record(Schema.String, Schema.String);
const Target = Schema.Struct({
  revision: Schema.String,
  contents: Schema.String,
  executable: Schema.Boolean,
});
const Plan = Schema.Struct({
  base: StringMap,
  remote: StringMap,
  captured: StringMap,
  target: Schema.Record(Schema.String, Target),
  renames: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  units: Schema.Array(Schema.Array(Schema.String)),
  guards: Schema.Array(Schema.Array(Schema.String)),
  markerPaths: Schema.Array(Schema.String),
});
const State = Schema.Struct({
  version: Schema.Literal(1),
  cwd: Schema.String,
  rootIdentity: Schema.Struct({ dev: Schema.String, ino: Schema.String }),
  plan: Plan,
  steps: Schema.Record(Schema.String, Schema.Literals(["done", "skipped", "attention"])),
  outcomes: Schema.Array(Schema.Literals(["pending", "done", "skipped", "interrupted"])),
  phase: Schema.Literals(["applying", "complete", "replan"]),
  nextBase: StringMap,
});
type State = typeof State.Type;
type StoredPlan = typeof Plan.Type;
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(State));
const encodePlan = Schema.encodeSync(Schema.fromJsonString(Plan));
export interface WorkspaceApplyPlan {
  readonly base: ReadonlyMap<string, string>;
  readonly remote: ReadonlyMap<string, string>;
  readonly captured: ReadonlyMap<string, string>;
  readonly target: ReadonlyMap<
    string,
    { readonly bytes: Uint8Array; readonly executable?: boolean }
  >;
  readonly renames: ReadonlyArray<Rename>;
  readonly conflicts: ReadonlyArray<ConflictGroup>;
  /** Only files where this plan intentionally writes Scient conflict material. */
  readonly markerPaths: ReadonlyArray<string>;
}
export interface WorkspaceApplyInput {
  readonly cwd: string;
  /** Existing host-owned directory on the manuscript filesystem. */
  readonly applicationDirectory: string;
  readonly id: string;
  readonly plan?: WorkspaceApplyPlan;
  readonly exchangeHelper?: string;
}
export interface WorkspaceApplyResult {
  readonly outcome: "complete" | "replan" | "attention";
  readonly base: ReadonlyMap<string, string>;
  readonly interrupted: ReadonlyArray<ReadonlyArray<string>>;
  readonly markerPaths: ReadonlyArray<string>;
  readonly retained: ReadonlyArray<RetainedMutationResult & { readonly changed: boolean }>;
  readonly matchesTarget: boolean;
  /** Temporary structural source copies excluded from manuscript capture. Never auto-delete. */
  readonly stagingPaths: ReadonlyArray<string>;
}
export class WorkspaceApplyError extends Schema.TaggedError<WorkspaceApplyError>()(
  "WorkspaceApplyError",
  { cause: Schema.Defect() },
) {}
export class WorkspaceApplier extends Context.Service<
  WorkspaceApplier,
  {
    readonly apply: (
      input: WorkspaceApplyInput,
    ) => Effect.Effect<WorkspaceApplyResult, WorkspaceApplyError>;
  }
>()("t3/scient/overleaf/WorkspaceApplier") {}
export interface ApplierHooks {
  readonly at?: (
    point: "recorded" | "before-step" | "after-step" | "step-recorded" | "base-recorded",
    relativePath?: string,
  ) => Promise<void>;
}

function ownValue<T>(values: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}
function storePlan(input: WorkspaceApplyPlan): StoredPlan {
  const target = Object.fromEntries(
    [...input.target].map(([name, file]) => [
      name,
      {
        revision: bytesRevision(file.bytes),
        contents: Buffer.from(file.bytes).toString("base64"),
        executable: file.executable ?? false,
      },
    ]),
  );
  for (const rename of input.renames)
    if (
      rename.from !== rename.to &&
      manuscriptCollisionKey(rename.from) === manuscriptCollisionKey(rename.to)
    )
      throw new Error("Alias-only renames need a separate manual rename before synchronization.");
  const changes: Array<Extract<FileChange, { path: string }>> = [
    ...new Set([...input.captured.keys(), ...input.target.keys()]),
  ]
    .filter((name) => input.captured.get(name) !== ownValue(target, name)?.revision)
    .map((name) => ({
      kind: !input.captured.has(name) ? "added" : !input.target.has(name) ? "deleted" : "modified",
      path: name,
    }));
  // Structural substitutions also form one unit, even when Git found no conflict.
  const structural: ConflictGroup[] = [...input.conflicts];
  const names = changes.map((change) => change.path);
  for (const parent of names) {
    const children = names.filter((child) => child.startsWith(`${parent}/`));
    if (children.length)
      structural.push({
        paths: [parent, ...children],
        types: ["structural apply"],
        origins: ["merge"],
      });
  }
  const units = applyUnits({ changes, renames: input.renames, conflicts: structural }).map(
    (indices) => indices.map((index) => changes[index]!.path),
  );
  const guards = units.map((unit) => {
    let paths = new Set(unit),
      size = -1;
    while (size !== paths.size) {
      size = paths.size;
      paths = new Set(closeOverRenames([...paths], input.renames));
      for (const group of structural)
        if (group.paths.some((name) => paths.has(name)))
          for (const name of group.paths) paths.add(name);
    }
    return [...paths];
  });
  return {
    base: Object.fromEntries(input.base),
    remote: Object.fromEntries(input.remote),
    captured: Object.fromEntries(input.captured),
    target,
    renames: [...input.renames],
    units,
    guards,
    markerPaths: [...input.markerPaths],
  };
}
function validatePlan(plan: StoredPlan) {
  for (const paths of [
    Object.keys(plan.base),
    Object.keys(plan.remote),
    Object.keys(plan.captured),
    Object.keys(plan.target),
  ]) {
    if (paths.length > 2000 || manuscriptTreeProblem(paths))
      throw new Error("Invalid manuscript apply tree.");
  }
  let total = 0;
  for (const file of Object.values(plan.target)) {
    if (file.executable) throw new Error("Executable manuscript entries are not supported.");
    const bytes = Buffer.from(file.contents, "base64");
    total += bytes.length;
    if (bytes.length > 50 * 1024 * 1024 || bytesRevision(bytes) !== file.revision)
      throw new Error("Invalid or oversized apply bytes.");
  }
  if (total > 250 * 1024 * 1024) throw new Error("Manuscript exceeds the local apply budget.");
  const changed = new Set(
    [...new Set([...Object.keys(plan.captured), ...Object.keys(plan.target)])].filter(
      (name) => ownValue(plan.captured, name) !== ownValue(plan.target, name)?.revision,
    ),
  );
  const covered = plan.units.flat();
  if (
    new Set(covered).size !== covered.length ||
    covered.length !== changed.size ||
    covered.some((name) => !changed.has(name))
  ) {
    throw new Error("Invalid apply units.");
  }
  if (
    plan.guards.length !== plan.units.length ||
    plan.guards.some(
      (guard, index) =>
        guard.some((name) => manuscriptPathProblem(name) !== null) ||
        plan.units[index]!.some((name) => !guard.includes(name)) ||
        manuscriptTreeProblem(guard.filter((name) => Object.hasOwn(plan.target, name))),
    )
  )
    throw new Error("Invalid apply guards.");
  if (plan.markerPaths.some((name) => !ownValue(plan.target, name)))
    throw new Error("Invalid conflict marker scope.");
}
async function revision(cwd: string, name: string) {
  try {
    const stat = await NodeFSP.lstat(NodePath.join(cwd, name));
    if (stat.isDirectory()) return null;
    if (stat.mode & 0o111) throw new Error("Executable manuscript entries are not supported.");
    return await fileRevision(NodePath.join(cwd, name));
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return null;
    throw e;
  }
}

export const make = (hooks: ApplierHooks = {}) =>
  Effect.gen(function* () {
    const files = yield* WorkspaceFileSystem;
    // One applier instance owns all its connection-local journals. Serializing local
    // applies prevents concurrent recovery of a shared record (no hidden queue in UI).
    const semaphore = yield* Semaphore.make(1);
    const apply: WorkspaceApplier["Service"]["apply"] = (input) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const begin = yield* Effect.tryPromise({
            try: async () => {
              if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(input.id)) throw new Error("Invalid apply id.");
              const cwd = await NodeFSP.realpath(input.cwd);
              const rootIdentity = await directoryIdentity(cwd);
              const owner = await NodeFSP.realpath(input.applicationDirectory);
              const directory = NodePath.join(owner, input.id);
              await NodeFSP.mkdir(directory, { mode: 0o700 }).catch((e) => {
                if (e.code !== "EEXIST") throw e;
              });
              await syncDirectory(owner);
              const stat = await NodeFSP.lstat(directory);
              if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error("Unsafe apply directory.");
              const recordPath = NodePath.join(directory, "apply.json");
              let state: State;
              try {
                state = decodeState(await NodeFSP.readFile(recordPath, "utf8"));
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !input.plan) throw e;
                const plan = storePlan(input.plan);
                validatePlan(plan);
                state = {
                  version: 1,
                  cwd,
                  rootIdentity,
                  plan,
                  steps: {},
                  outcomes: plan.units.map(() => "pending"),
                  phase: "applying",
                  nextBase: plan.base,
                };
                await durableJson(recordPath, state);
                await hooks.at?.("recorded");
              }
              if (state.cwd !== cwd) throw new Error("Apply workspace binding changed.");
              await assertRootBinding(cwd, state.rootIdentity);
              if (input.plan && encodePlan(storePlan(input.plan)) !== encodePlan(state.plan))
                throw new Error("Apply id reused with a different plan.");
              validatePlan(state.plan);
              if (state.outcomes.length !== state.plan.units.length)
                throw new Error("Invalid unit outcomes.");
              const retentionDirectory = NodePath.join(directory, "files");
              await NodeFSP.mkdir(retentionDirectory, { recursive: true, mode: 0o700 });
              await syncDirectory(directory);
              if ((await NodeFSP.stat(retentionDirectory)).dev !== (await NodeFSP.stat(cwd)).dev)
                throw new Error("Apply retention must be on manuscript filesystem.");
              if (state.phase === "applying" && Object.keys(state.steps).length === 0) {
                // No local write has begun: stale capture means re-plan with zero mutations.
                const records = await NodeFSP.readdir(retentionDirectory);
                let captureBytes = 0;
                if (records.length === 0)
                  for (const name of new Set([
                    ...Object.keys(state.plan.captured),
                    ...Object.keys(state.plan.target),
                  ])) {
                    const stat = await NodeFSP.lstat(NodePath.join(cwd, name)).catch((e) => {
                      if (["ENOENT", "ENOTDIR"].includes(e.code)) return null;
                      throw e;
                    });
                    if (stat?.isFile()) captureBytes += stat.size;
                    if (captureBytes > 250 * 1024 * 1024)
                      throw new Error("Capture exceeds local read budget.");
                    if (
                      (await revision(cwd, name)) !== (ownValue(state.plan.captured, name) ?? null)
                    ) {
                      state = { ...state, phase: "replan" };
                      await durableJson(recordPath, state);
                      break;
                    }
                  }
              }
              return { state, recordPath, retentionDirectory };
            },
            catch: (cause) => new WorkspaceApplyError({ cause }),
          });
          let state = begin.state;
          const save = () =>
            Effect.tryPromise({
              try: () => durableJson(begin.recordPath, state),
              catch: (cause) => new WorkspaceApplyError({ cause }),
            });
          if (state.phase === "applying")
            for (const [unitIndex, unit] of state.plan.units.entries()) {
              if (state.outcomes[unitIndex] !== "pending") continue;
              const blockers = unit.filter(
                (name) =>
                  !ownValue(state.plan.target, name) &&
                  unit.some(
                    (other) =>
                      ownValue(state.plan.target, other) &&
                      (other.startsWith(`${name}/`) || name.startsWith(`${other}/`)),
                  ),
              );
              // Explicit dependency layers: preserve/remove blocking entries, create
              // destinations, then remove remaining sources. No cyclic comparator.
              const ordered = [
                ...blockers.sort(),
                ...unit.filter((name) => ownValue(state.plan.target, name)).sort(),
                ...unit
                  .filter((name) => !ownValue(state.plan.target, name) && !blockers.includes(name))
                  .sort(),
              ];
              const destinationsIntact = async () => {
                await assertRootBinding(state.cwd, state.rootIdentity);
                for (const name of state.plan.guards[unitIndex]!) {
                  const target = ownValue(state.plan.target, name);
                  if (
                    (!unit.includes(name) || ownValue(state.steps, name) === "done") &&
                    (await revision(state.cwd, name)) !== (target?.revision ?? null)
                  )
                    return false;
                }
                return true;
              };
              let failed = false;
              for (const name of ordered) {
                const intact = yield* Effect.tryPromise({
                  try: destinationsIntact,
                  catch: (cause) => new WorkspaceApplyError({ cause }),
                });
                if (!intact) {
                  failed = true;
                  break;
                }
                if (ownValue(state.steps, name) === "done") continue;
                yield* Effect.tryPromise({
                  try: () => hooks.at?.("before-step", name) ?? Promise.resolve(),
                  catch: (cause) => new WorkspaceApplyError({ cause }),
                });
                if (
                  !(yield* Effect.tryPromise({
                    try: destinationsIntact,
                    catch: (cause) => new WorkspaceApplyError({ cause }),
                  }))
                ) {
                  failed = true;
                  break;
                }
                const file = ownValue(state.plan.target, name);
                const index = state.plan.units.flat().indexOf(name);
                const args = {
                  cwd: state.cwd,
                  relativePath: name,
                  retentionDirectory: begin.retentionDirectory,
                  id: `step-${index}`,
                  expectedRevision: ownValue(state.plan.captured, name) ?? null,
                  expectedRootIdentity: state.rootIdentity,
                  ...(blockers.includes(name)
                    ? {
                        visibleRetentionPath: NodePath.join(
                          state.cwd,
                          `.scient-overleaf-apply-${input.id}-${index}.tmp`,
                        ),
                      }
                    : {}),
                  ...(input.exchangeHelper ? { exchangeHelper: input.exchangeHelper } : {}),
                  ...(file
                    ? { bytes: Buffer.from(file.contents, "base64"), executable: file.executable }
                    : {}),
                };
                const outcome = yield* (
                  file ? files.replaceFileRetained(args) : files.removeFileRetained(args)
                ).pipe(
                  Effect.map((result) => result.outcome),
                  Effect.mapError((cause) => new WorkspaceApplyError({ cause })),
                );
                yield* Effect.tryPromise({
                  try: () => hooks.at?.("after-step", name) ?? Promise.resolve(),
                  catch: (cause) => new WorkspaceApplyError({ cause }),
                });
                state = { ...state, steps: Object.assign({}, state.steps, { [name]: outcome }) };
                yield* save();
                yield* Effect.tryPromise({
                  try: () => hooks.at?.("step-recorded", name) ?? Promise.resolve(),
                  catch: (cause) => new WorkspaceApplyError({ cause }),
                });
                if (outcome !== "done") {
                  failed = true;
                  break;
                }
              }
              if (!failed)
                failed = !(yield* Effect.tryPromise({
                  try: destinationsIntact,
                  catch: (cause) => new WorkspaceApplyError({ cause }),
                }));
              const outcome = !failed
                ? "done"
                : unit.some(
                      (name) => state.steps[name] === "done" || state.steps[name] === "attention",
                    )
                  ? "interrupted"
                  : "skipped";
              state = {
                ...state,
                outcomes: state.outcomes.map((old, index) => (index === unitIndex ? outcome : old)),
              };
              yield* save();
            }
          if (state.phase === "applying") {
            const undonePaths = state.plan.units.flatMap((_, i) =>
              state.outcomes[i] !== "done" ? state.plan.guards[i]! : [],
            );
            const next = advanceBase({
              before: new Map(Object.entries(state.plan.base)),
              remote: new Map(Object.entries(state.plan.remote)),
              undonePaths,
              renames: state.plan.renames,
            });
            state = { ...state, nextBase: Object.fromEntries(next), phase: "complete" };
            yield* save();
            yield* Effect.tryPromise({
              try: () => hooks.at?.("base-recorded") ?? Promise.resolve(),
              catch: (cause) => new WorkspaceApplyError({ cause }),
            });
          }
          return yield* Effect.tryPromise({
            try: async (): Promise<WorkspaceApplyResult> => {
              const retained: Array<RetainedMutationResult & { changed: boolean }> = [];
              for (const [index, name] of state.plan.units.flat().entries()) {
                const directory = NodePath.join(begin.retentionDirectory, `step-${index}`);
                try {
                  const record = decodeRetainedRecord(
                    await NodeFSP.readFile(NodePath.join(directory, "record.json"), "utf8"),
                  );
                  // Re-run the idempotent primitive through its shared lock below on the
                  // next invocation; here late retained writes are surfaced without deletion.
                  for (const leaf of ["slot", "retained"]) {
                    const kept = NodePath.join(directory, leaf);
                    const current = await fileRevision(kept);
                    if (
                      current !== null &&
                      (leaf === "retained" ||
                        record.stagedIdentity?.ino !== (await fileIdentity(kept))?.ino ||
                        record.stagedIdentity?.dev !== (await fileIdentity(kept))?.dev ||
                        current !== record.desired)
                    ) {
                      retained.push(
                        await recheckRetainedFile(
                          {
                            outcome: record.outcome ?? "attention",
                            recordDirectory: directory,
                            retainedPath: kept,
                            retainedRevision: current,
                            retainedIdentity: null,
                          },
                          ownValue(state.plan.captured, name) ?? null,
                        ),
                      );
                    }
                  }
                } catch (e) {
                  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                }
              }
              await assertRootBinding(state.cwd, state.rootIdentity);
              let matchesTarget = true;
              for (const name of new Set([
                ...Object.keys(state.plan.captured),
                ...Object.keys(state.plan.target),
              ])) {
                if (
                  (await revision(state.cwd, name)) !==
                  (ownValue(state.plan.target, name)?.revision ?? null)
                )
                  matchesTarget = false;
              }
              const markerPaths: string[] = [];
              for (const name of state.plan.markerPaths) {
                try {
                  if (hasConflictMarkers(await readMarkerText(NodePath.join(state.cwd, name))))
                    markerPaths.push(name);
                } catch (e) {
                  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                }
              }
              const interrupted = state.plan.guards.filter(
                (_, i) => state.outcomes[i] === "interrupted" || state.outcomes[i] === "skipped",
              );
              return {
                outcome:
                  state.phase === "replan"
                    ? "replan"
                    : state.outcomes.every((o) => o === "done") &&
                        retained.every((r) => !r.changed) &&
                        !markerPaths.length &&
                        matchesTarget
                      ? "complete"
                      : "attention",
                base: new Map(Object.entries(state.nextBase)),
                interrupted,
                markerPaths,
                retained,
                matchesTarget,
                stagingPaths: (await NodeFSP.readdir(state.cwd)).filter((name) =>
                  name.startsWith(`.scient-overleaf-apply-${input.id}-`),
                ),
              };
            },
            catch: (cause) => new WorkspaceApplyError({ cause }),
          });
        }).pipe(Effect.uninterruptible),
      );
    return WorkspaceApplier.of({ apply });
  });
export const layer = Layer.effect(WorkspaceApplier, make());

async function readMarkerText(path: string): Promise<string> {
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Unsafe marker file.");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 50 * 1024 * 1024) throw new Error("Marker file exceeds read budget.");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

import type {
  ProviderManagedRuntimeAction,
  ProviderRuntimeSummary,
  ServerProvider,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";

/** Kept outside the runtime folder, which Remove deletes. */
const BackgroundRecord = Schema.Struct({
  /** The user removed Scient Agent or cancelled install/repair: install only on request. */
  userStopped: Schema.optionalKey(Schema.Boolean),
  /** An update the user cancelled; a newer release is offered again. */
  skippedVersion: Schema.optionalKey(Schema.String),
  failures: Schema.optionalKey(Schema.Struct({ version: Schema.String, count: Schema.Number })),
  firstPickRecorded: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundRecord = typeof BackgroundRecord.Type;
const BackgroundRecordJson = Schema.fromJsonString(BackgroundRecord);
const decodeRecord = Schema.decodeEffect(BackgroundRecordJson);
const encodeRecord = Schema.encodeEffect(BackgroundRecordJson);
const MAX_FAILED_ATTEMPTS_PER_RELEASE = 5;

type BackgroundCheck =
  | { readonly kind: "start"; readonly action: "install" | "update"; readonly version: string }
  | { readonly kind: "wait"; readonly reason: string };

/** What, if anything, Scient may get ready on its own for this instance. */
export function backgroundRuntimeAction(
  provider: ServerProvider,
  record: BackgroundRecord,
): BackgroundCheck {
  const runtime = provider.connection?.runtime;
  if (runtime?.pendingRecovery) return { kind: "wait", reason: "requested-recovery" };
  if (!provider.enabled || !runtime) return { kind: "wait", reason: "unavailable" };
  const action: ProviderManagedRuntimeAction | undefined =
    runtime.source === "missing" && runtime.actions.includes("install")
      ? "install"
      : runtime.source === "scient_managed" && runtime.actions.includes("update")
        ? "update"
        : undefined;
  const version =
    action === "update"
      ? runtime.availableManagedVersion
      : (runtime.availableManagedVersion ?? runtime.qualifiedVersion);
  if (action === undefined || !version) return { kind: "wait", reason: "nothing-to-do" };
  if (action === "install" && record.userStopped) return { kind: "wait", reason: "user-stopped" };
  if (action === "update" && record.skippedVersion === version)
    return { kind: "wait", reason: "user-stopped" };
  if (
    record.failures?.version === version &&
    record.failures.count >= MAX_FAILED_ATTEMPTS_PER_RELEASE
  )
    return { kind: "wait", reason: "gave-up" };
  return { kind: "start", action, version };
}
/**
 * Remove or cancelled install stops automatic installs; cancelled update skips that release.
 * Cancelled repair does both. A successful requested change lets automatic setup resume.
 */
export function recordAfterUserChange(
  operation: Pick<NonNullable<ProviderRuntimeSummary["operation"]>, "action" | "status">,
  offeredVersion: string | null,
): ((record: BackgroundRecord) => BackgroundRecord) | undefined {
  const { action, status } = operation;
  if (
    (action === "remove" && status === "succeeded") ||
    (action === "install" && status === "cancelled")
  )
    return (record) => ({ ...record, userStopped: true });
  if (action === "repair" && status === "cancelled")
    return (record) => ({
      ...record,
      userStopped: true,
      ...(offeredVersion === null ? {} : { skippedVersion: offeredVersion }),
    });
  if (action === "update" && status === "cancelled" && offeredVersion !== null)
    return (record) => ({ ...record, skippedVersion: offeredVersion });
  if (action !== "remove" && status === "succeeded")
    return ({ userStopped: _stopped, skippedVersion: _skipped, ...rest }) => rest;
  return undefined;
}

export class ScientAgentRuntimePolicyError extends Schema.TaggedError<ScientAgentRuntimePolicyError>()(
  "ScientAgentRuntimePolicyError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Scient could not save the Agent background setup policy. Try again.";
  }
}

export class ScientAgentRuntimePolicy extends Context.Service<
  ScientAgentRuntimePolicy,
  {
    readonly read: Effect.Effect<BackgroundRecord, ScientAgentRuntimePolicyError>;
    /** Returns the previous record only after the change is persisted. */
    readonly update: (
      change: (record: BackgroundRecord) => BackgroundRecord,
    ) => Effect.Effect<BackgroundRecord, ScientAgentRuntimePolicyError>;
  }
>()("t3/scient/providerLifecycle/ScientAgentRuntimePolicy") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const recordPath = path.join(
    config.baseDir,
    "provider-runtimes",
    ".background",
    "scient-agent.json",
  );
  const read = fs.readFileString(recordPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed("{}"),
    ),
    Effect.flatMap(decodeRecord),
    Effect.mapError((cause) => new ScientAgentRuntimePolicyError({ path: recordPath, cause })),
  );
  const lock = yield* Semaphore.make(1);
  const update = Effect.fn("ScientAgentRuntimePolicy.update")(function* (
    change: (record: BackgroundRecord) => BackgroundRecord,
  ) {
    return yield* lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const record = yield* read;
          const contents = yield* encodeRecord(change(record)).pipe(Effect.orDie);
          yield* writeFileStringAtomically({
            filePath: recordPath,
            contents,
            mode: 0o600,
            durable: true,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HostProcess.Platform, platform),
            Effect.mapError(
              (cause) => new ScientAgentRuntimePolicyError({ path: recordPath, cause }),
            ),
          );
          return record;
        }),
      ),
    );
  });
  return ScientAgentRuntimePolicy.of({ read, update });
});

export const layer = Layer.effect(ScientAgentRuntimePolicy, make);

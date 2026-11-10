import {
  type EnvironmentSessionPrincipalShape,
  type ScientCloudEnrollmentProof,
  type ScientCloudShareBuildRequest,
  type ScientCloudStatus,
  type ScientCloudTakeOverRequest,
  type ScientCloudTakeOverResult,
  ScientCloudError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../serverSettings.ts";
import { CloudApi, type CloudApiError } from "./CloudApi.ts";
import { CloudSync } from "./CloudSync.ts";
import { CloudSyncState } from "./CloudSyncState.ts";
import { type BuiltShare, ShareBuilder } from "./ShareBuilder.ts";
import { TakeOverImport } from "./TakeOverImport.ts";

/** What the `scientCloud` HTTP group calls; each method is one route. */
export class ScientCloud extends Context.Service<
  ScientCloud,
  {
    readonly status: Effect.Effect<ScientCloudStatus>;
    readonly enrollmentProof: (input: {
      readonly nonce: string;
      readonly userId: string;
    }) => Effect.Effect<ScientCloudEnrollmentProof, ScientCloudError>;
    readonly enrollmentComplete: (
      userId: string,
    ) => Effect.Effect<ScientCloudStatus, ScientCloudError>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<ScientCloudStatus, ScientCloudError>;
    readonly stop: (deleteCopies: boolean) => Effect.Effect<ScientCloudStatus, ScientCloudError>;
    readonly shareBuild: (
      request: ScientCloudShareBuildRequest,
    ) => Effect.Effect<BuiltShare, ScientCloudError>;
    readonly takeOver: (
      request: ScientCloudTakeOverRequest,
      principal: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ScientCloudTakeOverResult, ScientCloudError>;
  }
>()("t3/scient/cloud/ScientCloud") {}

const fromApi = (error: CloudApiError) =>
  new ScientCloudError({
    reason:
      error.code === "network"
        ? "cloud-unavailable"
        : error.code === "unauthorized" || error.code === "forbidden"
          ? "not-enrolled"
          : "cloud-refused",
    message: error.message,
  });

const settingsFailed = () =>
  new ScientCloudError({ reason: "cloud-unavailable", message: "The setting could not be saved." });

const make = Effect.gen(function* () {
  const api = yield* CloudApi;
  const store = yield* CloudSyncState;
  const sync = yield* CloudSync;
  const settings = yield* ServerSettingsService;
  const shares = yield* ShareBuilder;
  const takeOvers = yield* TakeOverImport;

  const status = Effect.gen(function* () {
    const state = yield* store.get;
    const runtime = yield* sync.status;
    const copies = Object.values(state.threads);
    const lastCopiedAt = copies.reduce<string | null>(
      (latest, copy) => (latest === null || copy.uploadedAt > latest ? copy.uploadedAt : latest),
      null,
    );
    return {
      cloudUrl: api.cloudUrl,
      environmentId: yield* api.environmentId,
      enabled: yield* settings.getSettings.pipe(
        Effect.map((value) => value.scientCloudSyncEnabled),
        Effect.orElseSucceed(() => false),
      ),
      enrolledUserId: state.userId,
      state: runtime.state,
      paused: runtime.paused,
      lastCopiedAt,
      copiedThreads: copies.length,
      pendingThreads: runtime.pendingThreads,
      copiedBytes: copies.reduce((total, copy) => total + copy.bytes, 0),
      usedBytes: runtime.usedBytes,
      freeBytes: runtime.freeBytes,
      movedThreads: Object.entries(state.moved).map(([threadId, moved]) => ({
        threadId: threadId as ThreadId,
        ...moved,
      })),
      continuedThreads: Object.entries(state.continuedFrom).map(([threadId, from]) => ({
        threadId: threadId as ThreadId,
        from: { environmentId: from.env, threadId: from.thread },
      })),
    } satisfies ScientCloudStatus;
  });

  const setEnabled = Effect.fn("ScientCloud.setEnabled")(function* (enabled: boolean) {
    yield* settings
      .updateSettings({ scientCloudSyncEnabled: enabled })
      .pipe(Effect.mapError(settingsFailed));
    if (enabled) yield* sync.wake;
    return yield* status;
  });

  return ScientCloud.of({
    status,
    enrollmentProof: Effect.fn("ScientCloud.enrollmentProof")(function* ({ nonce, userId }) {
      const proof = yield* api.enrollmentProof({ userId, nonce }).pipe(Effect.mapError(fromApi));
      return {
        cloudUrl: api.cloudUrl,
        environmentId: yield* api.environmentId,
        label: (yield* api.label).trim().slice(0, 200) || "Computer",
        publicKey: yield* api.publicJwk.pipe(Effect.mapError(fromApi)),
        proof,
      };
    }),
    enrollmentComplete: Effect.fn("ScientCloud.enrollmentComplete")(function* (userId: string) {
      yield* api.limits(userId).pipe(
        Effect.mapError((error) =>
          error.code === "unauthorized" || error.code === "forbidden"
            ? new ScientCloudError({
                reason: "not-enrolled",
                message:
                  "Scient Cloud does not know this computer yet. Try turning Cloud copy on again.",
              })
            : fromApi(error),
        ),
      );
      // Copies made for another account are that account's; start the list again.
      yield* store.update((state) =>
        state.userId === userId && state.cloudUrl === api.cloudUrl
          ? state
          : {
              ...state,
              userId,
              cloudUrl: api.cloudUrl,
              threads: {},
              skipped: {},
              movedCursor: null,
            },
      );
      yield* sync.wake;
      return yield* status;
    }),
    setEnabled,
    stop: Effect.fn("ScientCloud.stop")(function* (deleteCopies: boolean) {
      if (deleteCopies) yield* sync.deleteCopies.pipe(Effect.mapError(fromApi));
      yield* settings
        .updateSettings({ scientCloudSyncEnabled: false })
        .pipe(Effect.mapError(settingsFailed));
      // Moved threads stay refused: they were continued elsewhere whatever happens here.
      yield* store.update((state) => ({
        ...state,
        userId: null,
        cloudUrl: null,
        threads: {},
        skipped: {},
        movedCursor: null,
      }));
      return yield* status;
    }),
    shareBuild: shares.build,
    takeOver: takeOvers.takeOver,
  });
});

export const layer = Layer.effect(ScientCloud, make);

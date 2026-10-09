/**
 * Scient's app-owned Cursor lifecycle composition.
 *
 * The provider package owns the SDK protocol and authentication. The server
 * supplies the managed CLI runtime, maintenance policy, assisted connection
 * summary, and native turn-receipt semantics that remain Scient-owned.
 */
import type { ServerProvider } from "@t3tools/contracts";
import {
  makeCursorDriver,
  type CursorDriverFactory,
  type CursorRuntimeResolverInput,
  type CursorRuntimeResolution,
} from "@t3tools/provider-cursor/server";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../config.ts";
import { makeCursorInstanceRuntime } from "../../scient/providerLifecycle/CursorManagedRuntimeActions.ts";
import { turnStartErrorKeepingReceipt } from "../../orchestration-v2/scient-provider/NativeTurnReceipts.ts";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import type { ScientProviderInstance } from "../ScientProviderInstance.ts";

/** App-specific services needed to resolve and compose the managed runtime. */
export type CursorDriverCompositionEnv =
  | ServerConfig.ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner;

type CursorDriverCompositionExtension = Pick<ScientProviderInstance, "managedRuntimeActions">;

const decorateCursorSnapshot = (
  snapshot: ServerProvider,
  runtime: NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>,
  connectionMethods: NonNullable<ServerProvider["connection"]>["methods"],
): ServerProvider => ({
  ...snapshot,
  connection: {
    methods: snapshot.auth.required === false ? [] : connectionMethods,
    canDisconnect:
      snapshot.auth.required !== false &&
      connectionMethods.length > 0 &&
      snapshot.auth.status === "authenticated",
    operation: null,
    runtime,
  },
});

const resolveRuntime = (
  input: CursorRuntimeResolverInput,
): Effect.Effect<
  CursorRuntimeResolution<CursorDriverCompositionEnv, CursorDriverCompositionExtension>,
  never,
  CursorDriverCompositionEnv
> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cursorRuntime = yield* makeCursorInstanceRuntime({
      config: input.config,
      enabled: input.enabled,
      baseDir: input.baseDir,
      managedInstallationAllowed: config.mode === "desktop",
      processEnv: input.processEnv,
      spawner,
    });

    return {
      effectiveConfig: cursorRuntime.effectiveConfig,
      effectiveEnvironment: cursorRuntime.effectiveProcessEnv,
      maintenanceResolver: cursorRuntime.maintenanceResolver,
      decorateSnapshot: (snapshot) =>
        decorateCursorSnapshot(
          snapshot,
          cursorRuntime.managedRuntime.summary,
          cursorRuntime.connectionMethods,
        ),
      composeInstance: (instance) =>
        Effect.succeed({
          ...instance,
          managedRuntimeActions: cursorRuntime.managedRuntime.actions,
        }),
      turnStartError: (turnIdentity, cause) =>
        turnStartErrorKeepingReceipt(CursorAgentSdk.CURSOR_PROVIDER, turnIdentity)(cause),
    };
  });

/** The exact Cursor driver registered in the production server catalog. */
export const CursorDriver: CursorDriverFactory<
  CursorDriverCompositionEnv,
  CursorDriverCompositionExtension
> = makeCursorDriver<CursorDriverCompositionEnv, CursorDriverCompositionExtension>({
  resolveRuntime,
});

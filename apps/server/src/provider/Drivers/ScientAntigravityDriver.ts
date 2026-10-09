/**
 * Scient's additions to the Antigravity driver: routing legacy `agy`
 * configurations to the legacy driver, the managed ACP runtime actions and
 * the connection state they stamp onto the snapshot, and the assisted
 * account actions built on the official auth controller.
 *
 * @module provider/Drivers/ScientAntigravityDriver
 */
import {
  type AntigravityAuthMethod,
  type AntigravitySettings,
  type ProviderInstanceId,
  ProviderSetupError,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import {
  antigravityConnectionMethod,
  makeAntigravityConnectionActionsFromController,
  makeAntigravityManagedRuntimeActions,
} from "../AntigravityLifecycleBridge.ts";
import type { AntigravityAuth } from "../AntigravityAuth.ts";
import type { AntigravityInstallation } from "../AntigravityInstallation.ts";
import { ANTIGRAVITY_ACP_TARGETS } from "@scientfactory/provider-runtime";
import { deriveProviderInstanceConfigMap } from "../ProviderInstanceRegistryHydration.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

export function usesLegacyAntigravityBackend(input: {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): boolean {
  const configured = input.binaryPath.trim();
  if (configured) {
    const normalized = configured.replaceAll("\\", "/");
    const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
    return basename === "agy" || basename === "agy.exe" || basename === "antigravity";
  }
  return !ANTIGRAVITY_ACP_TARGETS.some(
    (target) => target.platform === input.platform && target.arch === input.arch,
  );
}

/**
 * The instance's managed ACP runtime actions, and an identity stamp that adds
 * the connection method and runtime summary to the upstream identity.
 */
export function makeAntigravityRuntimeIdentity<E>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly getSettings: Effect.Effect<ServerSettings, E>;
  readonly installation: AntigravityInstallation["Service"];
  readonly settings: AntigravitySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly authMethod: AntigravityAuthMethod;
  readonly stampBaseIdentity: (draft: ServerProviderDraft) => ServerProvider;
}) {
  const { instanceId, platform, arch, stampBaseIdentity } = input;
  const protectedBinaryPaths = input.getSettings.pipe(
    Effect.map((current) =>
      Object.values(deriveProviderInstanceConfigMap(current)).flatMap((entry) => {
        const value =
          entry.config &&
          typeof entry.config === "object" &&
          "binaryPath" in entry.config &&
          typeof entry.config.binaryPath === "string"
            ? entry.config.binaryPath.trim()
            : "";
        return value ? [value] : [];
      }),
    ),
    Effect.mapError(
      (cause) =>
        new ProviderSetupError({
          instanceId,
          operation: "inspectSettings",
          detail: "Scient could not inspect provider paths before changing Antigravity.",
          cause,
        }),
    ),
  );
  const managedRuntimeActions = makeAntigravityManagedRuntimeActions({
    installation: input.installation,
    settings: input.settings,
    environment: input.environment,
    platform,
    arch,
    protectedBinaryPaths,
  });
  const stampIdentity = (draft: ServerProviderDraft) =>
    managedRuntimeActions.getSummary.pipe(
      Effect.orElseSucceed(() => ({
        source: "unknown" as const,
        supportTier: "unsupported" as const,
        target: `${platform}-${arch}`,
        actions: [],
        managedVersion: null,
        previousManagedVersion: null,
        operation: null,
        message: "Scient could not inspect the Antigravity ACP runtime.",
      })),
      Effect.map((runtime) => {
        const provider = stampBaseIdentity(draft);
        return {
          ...provider,
          connection: {
            methods: [antigravityConnectionMethod(input.authMethod)],
            canDisconnect: provider.auth.status === "authenticated",
            operation: null,
            runtime,
          },
        };
      }),
    );
  return { managedRuntimeActions, stampIdentity };
}

/** Scient's account actions over the instance's official ACP auth controller. */
export function makeAntigravityInstanceConnectionActions<E>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly authMethod: AntigravityAuthMethod;
  readonly authFlow: Pick<AntigravityAuth, "controller" | "stopProcesses">;
  readonly randomUUID: Effect.Effect<string, E>;
}) {
  const { instanceId, authFlow } = input;
  return makeAntigravityConnectionActionsFromController({
    instanceId,
    authMethod: input.authMethod,
    controller: authFlow.controller,
    stopSessions: authFlow.stopProcesses.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.fail(
              new ProviderSetupError({
                instanceId,
                operation: "stopSessions",
                detail: "Scient could not stop active Antigravity sessions.",
                cause,
              }),
            ),
      ),
    ),
    randomOwnerId: input.randomUUID.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId,
            operation: "start",
            detail: "Scient could not create an Antigravity sign-in operation.",
            cause,
          }),
      ),
    ),
  });
}

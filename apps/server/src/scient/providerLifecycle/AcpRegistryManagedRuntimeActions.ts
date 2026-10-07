import {
  AcpRegistrySettings,
  ProviderRegistryInstallation,
  type ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeSummary,
  type ServerSettings as SettingsSnapshot,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

import type { ProviderManagedRuntimeActions } from "../../provider/ProviderDriver.ts";
import * as AcpRegistrySupport from "../../provider/acp/AcpRegistrySupport.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

const encodeInstallation = Schema.encodeEffect(Schema.fromJsonString(ProviderRegistryInstallation));
const decodeSettings = Schema.decodeUnknownOption(AcpRegistrySettings);
const actionFailure = (cause: { readonly message: string }) =>
  new ProviderConnectionActionError({ message: cause.message, cause });

/** Registry installs use their recorded owner, not a system executable's identity. */
export const makeAcpRegistryManagedRuntimeActions = Effect.fn(
  "AcpRegistryManagedRuntimeActions.make",
)(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceEnvironment: ProviderInstanceEnvironment;
  readonly cwd: string;
}) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const inspect = catalog
    .inspect(input.settings, input.environment)
    .pipe(Effect.mapError(actionFailure));
  const referencedByAnotherInstance = (settings: SettingsSnapshot) =>
    Object.entries(settings.providerInstances).some(([id, instance]) => {
      if (id === input.instanceId || instance.driver !== "acpRegistry") return false;
      const decoded = decodeSettings(instance.config);
      return (
        decoded._tag === "Some" &&
        decoded.value.agentId === input.settings.agentId &&
        decoded.value.commandPath.trim().length === 0
      );
    });
  const getSummary: ProviderManagedRuntimeActions["getSummary"] = Effect.gen(function* () {
    const inspection = yield* inspect;
    const installation = inspection.status === "ready" ? inspection.installation : undefined;
    const custom = input.settings.commandPath.trim().length > 0;
    const canInstall = !custom && inspection.status === "unprepared";
    return {
      source: custom
        ? "custom"
        : installation
          ? "registry"
          : inspection.status === "unprepared"
            ? "missing"
            : "unknown",
      supportTier: custom ? "external_runtime_supported" : "fully_assisted",
      target: `registry:${input.settings.agentId}:${installation?.installRoot ?? input.settings.distribution}`,
      actions: installation ? ["remove"] : canInstall ? ["install"] : [],
      managedVersion: installation?.version ?? null,
      previousManagedVersion: null,
      operation: null,
      message: custom
        ? "The configured external executable is not managed or removed by Scient."
        : installation
          ? "Scient owns this ACP Registry installation. Removing it preserves provider credentials and external tools."
          : canInstall
            ? "Install this ACP Registry agent in Scient's private tools directory."
            : "The ACP Registry installation could not be verified; check the provider configuration and installer availability.",
      ...(installation === undefined
        ? {}
        : {
            installation,
            diagnostics: {
              executable: installation.executablePath,
              version: installation.packageVersion ?? installation.version,
              homePath: null,
              backend: "ACP Registry",
            },
          }),
    } satisfies ProviderRuntimeSummary;
  });
  const readPlan = Effect.fn("AcpRegistryManagedRuntimeActions.readPlan")(function* (
    action: ProviderManagedRuntimeAction,
  ) {
    const summary = yield* getSummary;
    if (!summary.actions.includes(action))
      return yield* new ProviderConnectionActionError({
        message: "This ACP Registry installation does not support that action.",
      });
    if (action === "remove" && referencedByAnotherInstance(yield* serverSettings.getSettings))
      return yield* new ProviderConnectionActionError({
        message:
          "Another configured provider uses this registry installation. Remove those provider instances before removing the shared installation.",
      });
    const registryVersion =
      summary.installation?.version ??
      (yield* inspect.pipe(
        Effect.map((inspection) => ("version" in inspection ? inspection.version : null)),
      ));
    const installationIdentity = summary.installation
      ? yield* encodeInstallation(summary.installation).pipe(Effect.mapError(actionFailure))
      : "missing";
    return {
      summary,
      plan: {
        action,
        target: summary.target,
        version: registryVersion,
        downloadBytes: null,
        sourceLabel: "Scient-owned ACP Registry installation",
        catalogRevision: `${summary.target}:${registryVersion}:${action}:${installationIdentity}`,
        message:
          action === "remove"
            ? "Remove this app-owned registry installation. Other configured instances using the same agent must be removed first. Account credentials are kept."
            : "Install the registry's exact top-level version in Scient's private tools directory. Transitive dependencies may vary.",
      },
    };
  });
  const plan: ProviderManagedRuntimeActions["plan"] = (action) =>
    readPlan(action).pipe(Effect.map((result) => result.plan));
  const run: ProviderManagedRuntimeActions["run"] = Effect.fn(
    "AcpRegistryManagedRuntimeActions.run",
  )(function* (action, revision, report, awaitActivationWindow) {
    const initial = yield* readPlan(action);
    if (initial.plan.catalogRevision !== revision)
      return yield* new ProviderConnectionActionError({
        message: "The registry installation changed. Review its management action again.",
      });
    if (awaitActivationWindow) yield* awaitActivationWindow;
    yield* serverSettings
      .withSettingsSnapshot((settings) =>
        Effect.gen(function* () {
          const currentInstance = settings.providerInstances[input.instanceId];
          if (!currentInstance || currentInstance.driver !== "acpRegistry")
            return yield* new ProviderConnectionActionError({
              message: "This provider configuration changed. Reopen its management controls.",
            });
          const current = decodeSettings(currentInstance.config);
          if (
            current._tag === "None" ||
            !Equal.equals(
              { ...current.value, enabled: resolveProviderInstanceEnabled(currentInstance) },
              input.settings,
            ) ||
            !Equal.equals(currentInstance.environment ?? [], input.instanceEnvironment)
          )
            return yield* new ProviderConnectionActionError({
              message: "This provider configuration changed. Reopen its management controls.",
            });
          const refreshed = yield* readPlan(action);
          if (refreshed.plan.catalogRevision !== revision)
            return yield* new ProviderConnectionActionError({
              message: "The registry installation changed. Review its management action again.",
            });
          if (action === "remove") {
            const referenced = referencedByAnotherInstance(settings);
            if (referenced)
              return yield* new ProviderConnectionActionError({
                message:
                  "Another configured provider uses this registry installation. Remove those provider instances before removing the shared installation.",
              });
            yield* report({
              status: "removing",
              message: "Removing the app-owned ACP Registry installation; credentials are kept.",
            });
            const installation = refreshed.summary.installation;
            if (!installation)
              return yield* new ProviderConnectionActionError({
                message: "The reviewed registry installation is no longer available.",
              });
            const removed = yield* catalog
              .uninstallManagedBinary({
                agentId: input.settings.agentId,
                expectedInstallation: installation,
              })
              .pipe(Effect.mapError(actionFailure));
            if (!removed.removed)
              return yield* new ProviderConnectionActionError({
                message:
                  "The registry installation is reserved by another setup operation. It was not removed; review and retry when setup finishes.",
              });
          } else {
            yield* report({
              status: "installing",
              message: "Installing the exact ACP Registry package version.",
            });
            yield* catalog
              .resolve(input.settings, input.cwd, input.environment)
              .pipe(Effect.mapError(actionFailure));
          }
        }),
      )
      .pipe(Effect.mapError(actionFailure));
  });
  return { getSummary, plan, run } satisfies ProviderManagedRuntimeActions;
});

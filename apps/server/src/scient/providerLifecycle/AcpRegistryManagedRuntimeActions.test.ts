import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  type ProviderRegistryInstallation,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ServerSettings from "../../serverSettings.ts";
import { makeAcpRegistryManagedRuntimeActions } from "./AcpRegistryManagedRuntimeActions.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const decodeEnvironment = Schema.decodeSync(ProviderInstanceEnvironment);
const instanceDriver = ProviderDriverKind.make("acpRegistry");
const agentId = "example-agent";

interface CatalogState {
  installation: ProviderRegistryInstallation | undefined;
  uninstallCalls: number;
}

const installation = (version: string, receiptId = version): ProviderRegistryInstallation => ({
  agentId,
  distribution: "npx",
  version,
  installRoot: `/private/tools/${agentId}/${receiptId}`,
  executablePath: `/private/tools/${agentId}/${receiptId}/bin/${agentId}`,
  packageSpec: `@example/${agentId}@${version}`,
  packageVersion: version,
});

const makeCatalog = (state: CatalogState) =>
  AcpRegistrySupport.AcpRegistryCatalog.of({
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () =>
      Effect.sync(() =>
        state.installation === undefined
          ? {
              status: "unprepared" as const,
              agentId,
              version: "1.2.3",
              distribution: "npx" as const,
            }
          : {
              status: "ready" as const,
              agentId,
              version: state.installation.version,
              distribution: "npx" as const,
              installation: state.installation,
            },
      ),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: (input) =>
      Effect.sync(() => {
        state.uninstallCalls += 1;
        if (
          state.installation === undefined ||
          input.expectedInstallation === undefined ||
          !Equal.equals(state.installation, input.expectedInstallation)
        )
          return { agentId: input.agentId, removed: false };
        state.installation = undefined;
        return { agentId: input.agentId, removed: true };
      }),
  });

const providerEntry = (config: AcpRegistrySettings, environment = decodeEnvironment([])) => ({
  driver: instanceDriver,
  config,
  environment,
});

describe("AcpRegistryManagedRuntimeActions", () => {
  it.effect("protects shared installs and rejects a plan after owner settings change", () => {
    const ownerId = ProviderInstanceId.make("registry-owner");
    const siblingId = ProviderInstanceId.make("registry-sibling");
    const config = decodeSettings({ agentId, distribution: "npx" });
    const state: CatalogState = { installation: installation("1.2.3"), uninstallCalls: 0 };
    const layer = Layer.mergeAll(
      ServerSettings.layerTest({
        providerInstances: {
          [ownerId]: providerEntry(config),
          [siblingId]: providerEntry(config),
        },
      }),
      Layer.succeed(AcpRegistrySupport.AcpRegistryCatalog, makeCatalog(state)),
    );

    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const actions = yield* makeAcpRegistryManagedRuntimeActions({
        instanceId: ownerId,
        settings: config,
        instanceEnvironment: decodeEnvironment([]),
        environment: {},
        cwd: "/tmp",
      });

      expect(yield* actions.getSummary).toMatchObject({ source: "registry", actions: ["remove"] });
      const sharedError = yield* actions.plan("remove").pipe(Effect.flip);
      expect(sharedError.message).toContain("Another configured provider uses this registry");
      expect(state.uninstallCalls).toBe(0);

      yield* serverSettings.updateProviderInstance({ operation: "remove", instanceId: siblingId });
      const plan = yield* actions.plan("remove");
      const changedEnvironment = decodeEnvironment([
        { name: "PATH", value: "/changed", sensitive: false },
      ]);
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId: ownerId,
        instance: providerEntry(config, changedEnvironment),
      });
      const changedConfigError = yield* actions
        .run("remove", plan.catalogRevision, () => Effect.void)
        .pipe(Effect.flip);
      expect(changedConfigError.message).toContain("provider configuration changed");
      expect(state.uninstallCalls).toBe(0);

      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId: ownerId,
        instance: providerEntry(config),
      });
      yield* actions.run("remove", plan.catalogRevision, () => Effect.void);
      expect(state.uninstallCalls).toBe(1);
      expect(state.installation).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "rejects stale catalog revisions and preserves a receipt changed at removal time",
    () => {
      const ownerId = ProviderInstanceId.make("registry-owner");
      const config = decodeSettings({ agentId, distribution: "npx" });
      const state: CatalogState = { installation: installation("1.2.3"), uninstallCalls: 0 };
      const layer = Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: { [ownerId]: providerEntry(config) },
        }),
        Layer.succeed(AcpRegistrySupport.AcpRegistryCatalog, makeCatalog(state)),
      );

      return Effect.gen(function* () {
        const actions = yield* makeAcpRegistryManagedRuntimeActions({
          instanceId: ownerId,
          settings: config,
          instanceEnvironment: decodeEnvironment([]),
          environment: {},
          cwd: "/tmp",
        });
        const reviewed = yield* actions.plan("remove");

        state.installation = installation("1.2.4");
        const stalePlanError = yield* actions
          .run("remove", reviewed.catalogRevision, () => Effect.void)
          .pipe(Effect.flip);
        expect(stalePlanError.message).toContain("installation changed");
        expect(state.uninstallCalls).toBe(0);

        const latest = yield* actions.plan("remove");
        const replacement = installation("1.2.4", "replacement-receipt");
        const racedError = yield* actions
          .run("remove", latest.catalogRevision, (progress) =>
            progress.status === "removing"
              ? Effect.sync(() => {
                  state.installation = replacement;
                })
              : Effect.void,
          )
          .pipe(Effect.flip);
        expect(racedError.message).toContain("reserved by another setup operation");
        expect(state.uninstallCalls).toBe(1);
        expect(state.installation).toEqual(replacement);
      }).pipe(Effect.provide(layer));
    },
  );
});

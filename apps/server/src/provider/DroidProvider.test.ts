import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DroidSettings, ProviderDriverKind } from "@t3tools/contracts";
import { applyAutomaticModelDefaults, resolveAutomaticModel } from "@t3tools/shared/model";
import { AcpRequestError } from "effect-acp/errors";
import type { DroidAcpRuntime, DroidAcpRuntimeFactory } from "./acp/DroidAcpSupport.ts";

import {
  buildInitialDroidProviderSnapshot,
  checkDroidProviderStatus,
  checkDroidProviderStatusWithCapabilities,
  isDroidAuthenticationRequiredError,
} from "./DroidProvider.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const DROID = ProviderDriverKind.make("droid");

const modelCatalog = [
  { value: "native-model", name: "Native model" },
  { value: "custom:personal-model", name: "Personal BYOK" },
  { value: "custom:scient-fixture", name: "Scient BYOK" },
];

// Only the ACP boundary is simulated: exercise the real status probe, catalog
// mapping without accounts or inference requests.
const catalogRuntime = (
  catalog = modelCatalog,
  failSelection = false,
  current = "native-model",
) => {
  let currentValue = current;
  const selections: string[] = [];
  const options = () => [
    {
      id: "model",
      name: "Model",
      category: "model" as const,
      type: "select" as const,
      currentValue,
      options: catalog,
    },
  ];
  const initializeResult = { protocolVersion: 1, agentCapabilities: {} };
  const runtime = {
    initialize: () => Effect.succeed(initializeResult),
    start: () =>
      Effect.succeed({
        sessionId: "fixture",
        initializeResult,
        sessionSetupResult: { sessionId: "fixture", configOptions: options() },
      }),
    getConfigOptions: Effect.sync(options),
    setModel: (slug: string) =>
      Effect.gen(function* () {
        selections.push(slug);
        if (failSelection && slug === "custom:personal-model")
          return yield* new AcpRequestError({ code: -32602, errorMessage: "Ladder unavailable" });
        currentValue = slug;
      }),
  } as unknown as DroidAcpRuntime;
  return {
    makeRuntime: (() => Effect.succeed(runtime)) satisfies DroidAcpRuntimeFactory,
    selections,
  };
};

const versionOnlyDroid = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-catalog-" });
  const binaryPath = path.join(dir, "droid");
  yield* fs.writeFileString(binaryPath, '#!/bin/sh\nprintf "droid-cli 0.0.99\\n"\n');
  yield* fs.chmod(binaryPath, 0o755);
  return binaryPath;
});

it.layer(NodeServices.layer)("Droid catalog ownership", (it) => {
  it.effect("keeps native and Scient BYOK discovery distinct from legacy custom entries", () =>
    Effect.gen(function* () {
      const binaryPath = yield* versionOnlyDroid;
      const fixture = catalogRuntime();
      const { snapshot } = yield* checkDroidProviderStatusWithCapabilities(
        decodeDroidSettings({
          enabled: true,
          binaryPath,
          customModels: ["custom:scient-fixture", "manual-only"],
        }),
        {},
        fixture.makeRuntime,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map(({ slug, isCustom }) => ({ slug, isCustom }))).toEqual(
        modelCatalog.map(({ value }) => ({ slug: value, isCustom: false })),
      );
      expect(snapshot.models[2]?.name).toBe("Scient BYOK");
      const pending = yield* buildInitialDroidProviderSnapshot(
        decodeDroidSettings({ customModels: ["manual-only"] }),
      );
      expect(pending.models[0]?.isCustom).toBe(true);
      expect(snapshot.models.slice(0, 3).every((model) => model.capabilities !== null)).toBe(true);
      expect(fixture.selections.at(-1)).toBe("native-model");
    }).pipe(Effect.scoped),
  );

  it.effect("retains the entire discovered catalog when a model's ladder cannot be read", () =>
    Effect.gen(function* () {
      const fixture = catalogRuntime(modelCatalog, true);
      const { snapshot } = yield* checkDroidProviderStatusWithCapabilities(
        decodeDroidSettings({ enabled: true, binaryPath: yield* versionOnlyDroid }),
        {},
        fixture.makeRuntime,
      );
      expect(snapshot.models.map((model) => model.slug)).toEqual(
        modelCatalog.map((model) => model.value),
      );
      expect(snapshot.models.every((model) => !model.isCustom)).toBe(true);
      expect(snapshot.models[1]?.capabilities).toBeNull();
      expect(fixture.selections.at(-1)).toBe("native-model");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "marks the model Droid starts a session with as the default, not the first listed",
    () =>
      Effect.gen(function* () {
        const catalog = [
          { value: "claude-fable-5.1", name: "Fable" },
          { value: "gpt-6-sol", name: "Sol" },
          { value: "custom:scient-fixture", name: "Scient BYOK" },
        ];
        const fixture = catalogRuntime(catalog, false, "gpt-6-sol");
        const { snapshot } = yield* checkDroidProviderStatusWithCapabilities(
          decodeDroidSettings({ enabled: true, binaryPath: yield* versionOnlyDroid }),
          {},
          fixture.makeRuntime,
        );
        expect(
          snapshot.models.filter((model) => model.isDefault).map((model) => model.slug),
        ).toEqual(["gpt-6-sol"]);
        // The shared policy every client uses starts new threads on it, and
        // the registry publishes the same flag unchanged.
        expect(resolveAutomaticModel(DROID, snapshot.models)).toBe("gpt-6-sol");
        expect(
          applyAutomaticModelDefaults(DROID, snapshot.models)
            .filter((model) => model.isDefault)
            .map((model) => model.slug),
        ).toEqual(["gpt-6-sol"]);
        // The discovery walk restores Droid's own selection.
        expect(fixture.selections.at(-1)).toBe("gpt-6-sol");
      }).pipe(Effect.scoped),
  );

  it.effect("a fresh discovery removes detached models and uses current names", () =>
    Effect.gen(function* () {
      const settings = decodeDroidSettings({ enabled: true, binaryPath: yield* versionOnlyDroid });
      const before = yield* checkDroidProviderStatusWithCapabilities(
        settings,
        {},
        catalogRuntime().makeRuntime,
      );
      const next = modelCatalog
        .slice(0, 2)
        .map((model) => ({ ...model, name: `${model.name} updated` }));
      const after = yield* checkDroidProviderStatusWithCapabilities(
        settings,
        {},
        catalogRuntime(next).makeRuntime,
      );
      expect(before.snapshot.models).toHaveLength(3);
      expect(after.snapshot.models.map((model) => model.slug)).toEqual(
        next.map((model) => model.value),
      );
      expect(after.snapshot.models[1]?.name).toBe("Personal BYOK updated");
    }).pipe(Effect.scoped),
  );
});
describe("buildInitialDroidProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(
        decodeDroidSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Droid is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(decodeDroidSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("never offers conversation rewind for Droid", () =>
    Effect.gen(function* () {
      for (const enabled of [true, false]) {
        const snapshot = yield* buildInitialDroidProviderSnapshot(decodeDroidSettings({ enabled }));
        expect(snapshot.supportsConversationRollback).toBe(false);
      }
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(
        decodeDroidSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Droid");
    }),
  );

  it.effect("keeps configured but unobserved custom-model capabilities unknown", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(
        decodeDroidSettings({ enabled: true, customModels: ["custom:model"] }),
      );
      expect(snapshot.models[0]?.slug).toBe("custom:model");
      expect(snapshot.models[0]?.capabilities).toBeNull();
    }),
  );
});

it.layer(NodeServices.layer)("checkDroidProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDroidProviderStatus(
        decodeDroidSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/droid-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken droid install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-droid-version-" });
          const droidPath = path.join(dir, "droid");
          yield* fs.writeFileString(
            droidPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(droidPath, 0o755);

          return yield* checkDroidProviderStatus(
            decodeDroidSettings({ enabled: true, binaryPath: droidPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Droid CLI is installed but failed to run.");
      // CLI stderr must never leak into the user-facing snapshot message.
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("says why ACP startup failed, without the process's own output", () =>
    Effect.gen(function* () {
      const secretStderr = "fatal: secret-token-value";
      const exited = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-droid-acp-exit-" });
          const droidPath = path.join(dir, "droid");
          yield* fs.writeFileString(
            droidPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then printf "0.230.0\\n"; exit 0; fi',
              `printf "%s\\n" "${secretStderr}" >&2`,
              "exit 3",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(droidPath, 0o755);
          return yield* checkDroidProviderStatus(
            decodeDroidSettings({ enabled: true, binaryPath: droidPath }),
          );
        }),
      );
      expect(exited.status).toBe("error");
      expect(exited.message).toBe(
        "Droid CLI is installed but ACP startup failed: Droid exited with code 3 before it was ready.",
      );
      expect(exited.message).not.toContain(secretStderr);

      // Droid's own answer to a startup request is the reason.
      const refused = yield* Effect.scoped(
        Effect.gen(function* () {
          const initializeResult = { protocolVersion: 1, agentCapabilities: {} };
          const runtime = {
            initialize: () => Effect.succeed(initializeResult),
            start: () =>
              Effect.fail(
                new AcpRequestError({
                  code: -32603,
                  errorMessage:
                    "Invalid settings: hooks must be an object (key fk-live-0123456789abcdef, token gateway-token-0123456789)\nat loadSettings",
                }),
              ),
          } as unknown as DroidAcpRuntime;
          return yield* checkDroidProviderStatusWithCapabilities(
            decodeDroidSettings({ enabled: true, binaryPath: yield* versionOnlyDroid }),
            { FACTORY_API_KEY: "fk-live-0123456789abcdef" },
            () => Effect.succeed(runtime),
            process.cwd(),
            ["gateway-token-0123456789"],
          );
        }),
      );
      expect(refused.snapshot.status).toBe("error");
      // Droid's answer, without the instance's credentials it repeated.
      expect(refused.snapshot.message).toBe(
        'Droid CLI is installed but ACP startup failed: Droid answered "Invalid settings: hooks must be an object (key [redacted], token [redacted])".',
      );
      expect(refused.snapshot.auth.status).toBe("unknown");
    }),
  );

  it.effect("reports an error status when ACP startup fails without an auth signal", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-droid-acp-fail-" });
          const droidPath = path.join(dir, "droid");
          // A version-healthy binary that is not a real ACP agent: the probe
          // fails at startup with no "authentication required" anywhere.
          yield* fs.writeFileString(
            droidPath,
            ["#!/bin/sh", 'printf "droid-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(droidPath, 0o755);

          return yield* checkDroidProviderStatus(
            decodeDroidSettings({ enabled: true, binaryPath: droidPath }),
          );
        }),
      );

      // The fake binary prints a version but is not a real ACP agent, so the
      // probe fails at startup: error status, honest message — and crucially
      // NOT an unauthenticated verdict.
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.0.99");
      expect(snapshot.message).toContain("ACP startup");
      expect(snapshot.auth.status).not.toBe("unauthenticated");
    }),
  );
});

describe("isDroidAuthenticationRequiredError", () => {
  it("matches the scoped authentication-required signal", () => {
    // The exact wire failure observed from `@factory/cli` on session/new.
    assert.isTrue(
      isDroidAuthenticationRequiredError({
        code: -32000,
        errorMessage: "Authentication required. Please log in.",
      }),
    );
    assert.isTrue(isDroidAuthenticationRequiredError(new Error("authentication required")));
  });

  it("rejects generic -32000 server errors and unrelated failures", () => {
    // -32000 is a generic server-error range: code alone is not an auth
    // signal (regression guard for the original over-broad classifier).
    assert.isFalse(
      isDroidAuthenticationRequiredError({ code: -32000, errorMessage: "internal error" }),
    );
    assert.isFalse(isDroidAuthenticationRequiredError({ code: -32602 }));
    assert.isFalse(isDroidAuthenticationRequiredError(new Error("spawn ENOENT")));
    assert.isFalse(isDroidAuthenticationRequiredError(undefined));
  });
});

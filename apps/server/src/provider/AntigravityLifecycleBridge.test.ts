import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { AntigravityInstallation } from "./AntigravityInstallation.ts";
import {
  makeAntigravityConnectionActionsFromController,
  makeAntigravityManagedRuntimeActions,
} from "./AntigravityLifecycleBridge.ts";
import { ANTIGRAVITY_RELEASE_VERSION } from "./antigravityRelease.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";
import { bundledAntigravityAcpAsset } from "../scient/providerLifecycle/antigravityAcpCatalog.ts";

const instanceId = ProviderInstanceId.make("antigravity-lifecycle-test");
const driver = ProviderDriverKind.make("antigravity");
const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=lifecycle-test";
const callbackUrl = "http://127.0.0.1:51234/?state=lifecycle-test&code=fixture";

function authState(
  phase: ProviderAuthState["phase"],
  overrides: Partial<ProviderAuthState> = {},
): ProviderAuthState {
  return {
    instanceId,
    phase,
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    ...overrides,
  };
}

it.effect("bridges official Google auth into Scient's one-click connection flow", () =>
  Effect.gen(function* () {
    let current = authState("waiting", {
      flowId: "flow-1",
      authorizationUrl,
    });
    const calls: string[] = [];
    const controller: ProviderAuthController = {
      start: (owner, stopSessions) =>
        (stopSessions ?? Effect.void).pipe(
          Effect.tap(() => Effect.sync(() => calls.push(`start:${owner}`))),
          Effect.as(current),
        ),
      complete: (owner, input) =>
        Effect.sync(() => {
          calls.push(`complete:${owner}:${input.callbackUrl}`);
          current = authState("succeeded", { flowId: input.flowId });
          return current;
        }),
      cancel: (owner, flowId) =>
        Effect.sync(() => {
          calls.push(`cancel:${owner}:${flowId}`);
          current = authState("cancelled", { flowId });
          return current;
        }),
      logout: (stopSessions) =>
        stopSessions.pipe(
          Effect.tap(() => Effect.sync(() => calls.push("logout"))),
          Effect.as(authState("idle")),
        ),
      subscribe: () => Stream.suspend(() => Stream.make(current)),
    };
    const actions = makeAntigravityConnectionActionsFromController({
      instanceId,
      authMethod: "oauth-personal",
      controller,
      stopSessions: Effect.sync(() => calls.push("stop-sessions")),
      randomOwnerId: Effect.succeed("owner"),
    });

    expect(actions.methods).toEqual(["antigravity_google"]);
    const attempt = yield* actions.start("antigravity_google");
    expect(attempt.authorizationUrl).toBe(authorizationUrl);
    expect(attempt.initialStatus).toBe("waiting_for_browser");
    expect(attempt.authorizationResponseKind).toBe("callback_url");
    if (!attempt.submitAuthorizationCode) {
      return yield* Effect.die("Expected the Google return URL handoff.");
    }
    yield* attempt.submitAuthorizationCode(callbackUrl);
    yield* attempt.waitForCompletion;
    yield* actions.disconnect;

    expect(calls).toEqual([
      "stop-sessions",
      "start:scient-provider-lifecycle-owner",
      `complete:scient-provider-lifecycle-owner:${callbackUrl}`,
      "stop-sessions",
      "logout",
    ]);
  }).pipe(Effect.scoped),
);

it.effect(
  "bridges credential authentication and cancels its owned flow when the lifecycle scope closes",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const cancelled: string[] = [];
      const controller: ProviderAuthController = {
        start: () => Effect.succeed(authState("verifying", { flowId: "credential-flow" })),
        complete: () => Effect.die("Credential auth must not submit a browser callback"),
        cancel: (_owner, flowId) =>
          Effect.sync(() => {
            cancelled.push(flowId);
            return authState("cancelled", { flowId });
          }),
        logout: () => Effect.succeed(authState("idle")),
        subscribe: () => Stream.never,
      };
      const actions = makeAntigravityConnectionActionsFromController({
        instanceId,
        authMethod: "gemini-api-key",
        controller,
        stopSessions: Effect.void,
        randomOwnerId: Effect.succeed("credential-owner"),
      });
      expect(actions.methods).toEqual(["antigravity_credentials"]);
      const attempt = yield* actions
        .start("antigravity_credentials")
        .pipe(Effect.provideService(Scope.Scope, scope));
      expect(attempt.initialStatus).toBe("verifying");
      expect(attempt.authorizationUrl).toBeUndefined();
      expect(attempt.submitAuthorizationCode).toBeUndefined();
      yield* Scope.close(scope, Exit.void);
      expect(cancelled).toEqual(["credential-flow"]);
    }),
);

function installState(
  phase: ProviderInstallState["phase"],
  overrides: Partial<ProviderInstallState> = {},
): ProviderInstallState {
  return {
    driver,
    operationId: null,
    phase,
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: "previous-release",
    canRemove: true,
    message: null,
    ...overrides,
  };
}

it.effect("classifies system, custom, and managed ACP runtimes without taking ownership", () =>
  Effect.gen(function* () {
    const source = { current: "path" as "path" | "override" | "managed" };
    const installation = AntigravityInstallation.of({
      managedDirectory: "/managed/antigravity",
      latestRelease: Effect.succeed(bundledAntigravityAcpAsset("linux", "x64")),
      refreshLatestRelease: Effect.succeed(bundledAntigravityAcpAsset("linux", "x64")),
      startRelease: () => Effect.die("not used"),
      resolve: (binaryPath) =>
        Effect.succeed({
          executablePath: binaryPath || "/usr/local/bin/agy_acp_server.par",
          harnessPath: "/usr/local/bin/localharness_external",
          source: source.current,
          version: "system-release",
          registryVersion: "0.9.0",
          managedVersionDirectory:
            source.current === "managed" ? "/managed/antigravity/versions/old" : null,
        }),
      acquire: () => Effect.die("not used"),
      start: Effect.die("not used"),
      cancel: () => Effect.die("not used"),
      state: Effect.succeed(installState("idle")),
      changes: Stream.empty,
      remove: () => Effect.die("not used"),
    });
    const makeActions = (binaryPath: string) =>
      makeAntigravityManagedRuntimeActions({
        installation,
        settings: {
          enabled: true,
          authMethod: "oauth-personal",
          apiKey: "",
          gcpProject: "",
          gcpLocation: "",
          binaryPath,
          customModels: [],
        },
        environment: {},
        platform: "linux",
        arch: "x64",
        protectedBinaryPaths: Effect.succeed([]),
      });

    expect(yield* makeActions("").getSummary).toMatchObject({
      source: "system",
      actions: ["install"],
    });
    source.current = "override";
    expect(yield* makeActions("/custom/agy_acp_server.par").getSummary).toMatchObject({
      source: "custom",
      actions: [],
    });
    source.current = "managed";
    expect(yield* makeActions("").getSummary).toMatchObject({
      source: "scient_managed",
      actions: ["update", "repair", "remove"],
    });
  }),
);

it.effect("never removes a managed runtime when its repair download or verification fails", () =>
  Effect.gen(function* () {
    let starts = 0;
    let removes = 0;
    let refreshes = 0;
    const bundled = bundledAntigravityAcpAsset("linux", "x64")!;
    let current: typeof bundled | null = bundled;
    const newest = {
      ...bundled,
      version: "agy_acp_server_9.0.0",
      registryVersion: "9.0.0",
      sha256: "9".repeat(64),
    };
    const installation = AntigravityInstallation.of({
      managedDirectory: "/managed/antigravity",
      latestRelease: Effect.sync(() => current),
      refreshLatestRelease: Effect.sync(() => {
        refreshes++;
        current = newest;
        return current;
      }),
      resolve: () =>
        Effect.succeed({
          executablePath: "/managed/antigravity/agy_acp_server.par",
          harnessPath: "/managed/antigravity/localharness_external",
          source: "managed",
          version: ANTIGRAVITY_RELEASE_VERSION,
          managedVersionDirectory: "/managed/antigravity/versions/current",
        }),
      acquire: () => Effect.die("not used"),
      start: Effect.die("Use the exact reviewed release"),
      startRelease: () =>
        Effect.sync(() => {
          starts += 1;
          return installState("downloading", {
            operationId: `operation-${starts}`,
            version: ANTIGRAVITY_RELEASE_VERSION,
          });
        }),
      cancel: () => Effect.die("not used"),
      state: Effect.succeed(
        installState("idle", { installedVersion: ANTIGRAVITY_RELEASE_VERSION }),
      ),
      changes: Stream.suspend(() =>
        Stream.make(
          starts === 1
            ? installState("failed", {
                operationId: "operation-1",
                message: "The managed runtime failed verification.",
              })
            : installState("succeeded", {
                operationId: "operation-2",
                version: ANTIGRAVITY_RELEASE_VERSION,
                installedVersion: ANTIGRAVITY_RELEASE_VERSION,
              }),
        ),
      ),
      remove: () =>
        Effect.sync(() => {
          removes += 1;
        }),
    });
    const actions = makeAntigravityManagedRuntimeActions({
      installation,
      settings: {
        enabled: true,
        authMethod: "oauth-personal",
        apiKey: "",
        gcpProject: "",
        gcpLocation: "",
        binaryPath: "",
        customModels: [],
      },
      environment: {},
      platform: "linux",
      arch: "x64",
      protectedBinaryPaths: Effect.succeed(["/other/custom/runtime"]),
    });
    yield* actions.getSummary;
    expect(refreshes).toBe(0);
    const plan = yield* actions.plan("repair");
    expect(refreshes).toBe(1);
    expect(plan.version).toBe(newest.version);
    const progress: string[] = [];
    const error = yield* actions
      .run("repair", plan.catalogRevision, (update) =>
        Effect.sync(() => progress.push(update.status)),
      )
      .pipe(Effect.flip);

    expect(error.message).toContain("failed verification");
    expect(starts).toBe(1);
    expect(removes).toBe(0);
    expect(progress).toEqual(["downloading", "preparing"]);
    current = { ...newest, sha256: "8".repeat(64) };
    expect(
      (yield* actions.run("repair", plan.catalogRevision, () => Effect.void).pipe(Effect.flip))
        .message,
    ).toContain("plan changed");
    expect(starts).toBe(1);
    const removePlan = yield* actions.plan("remove");
    current = null; // Removal does not depend on the download catalog.
    yield* actions.run("remove", removePlan.catalogRevision, () => Effect.void);
    expect(removes).toBe(1);
    expect(refreshes).toBe(1);
  }),
);

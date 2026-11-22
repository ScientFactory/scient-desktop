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

import { AntigravityInstallation } from "../../provider/AntigravityInstallation.ts";
import {
  makeAntigravityConnectionActionsFromController,
  makeAntigravityManagedRuntimeActions,
} from "./AntigravityAcpLifecycleActions.ts";
import type { ProviderAuthController } from "../../provider/ProviderAuthService.ts";
import {
  ANTIGRAVITY_RELEASE_VERSION,
  bundledAntigravityAcpAsset,
} from "./antigravityAcpCatalog.ts";
import { ANTIGRAVITY_SESSION_SETUP_FAILED_MESSAGE } from "./antigravityAuthDiagnostics.ts";
import type { AntigravityManagedRelease } from "./antigravityRuntimeRelease.ts";

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
  "sends the agy CLI's Antigravity page code through the controller's code interaction",
  () =>
    Effect.gen(function* () {
      const codeAuthorizationUrl =
        "https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=cli-test";
      let current = authState("waiting", {
        flowId: "flow-cli",
        authorizationUrl: codeAuthorizationUrl,
        interaction: {
          type: "credentials",
          id: "flow-cli",
          fields: [{ name: "code", label: "Code from the Antigravity page", secret: false }],
        },
      });
      const calls: string[] = [];
      const controller: ProviderAuthController = {
        start: (_owner, stopSessions) => (stopSessions ?? Effect.void).pipe(Effect.as(current)),
        complete: (_owner, input) =>
          Effect.sync(() => {
            calls.push(`complete:${input.callbackUrl}`);
            return current;
          }),
        respond: (owner, input) =>
          Effect.sync(() => {
            calls.push(`respond:${owner}:${input.flowId}:${input.interactionId}`);
            calls.push(JSON.stringify(input.response));
            current = authState("succeeded", { flowId: input.flowId });
            return current;
          }),
        cancel: (_owner, flowId) => Effect.succeed(authState("cancelled", { flowId })),
        logout: (stopSessions) => stopSessions.pipe(Effect.as(authState("idle"))),
        subscribe: () => Stream.suspend(() => Stream.make(current)),
      };
      const actions = makeAntigravityConnectionActionsFromController({
        instanceId,
        authMethod: "oauth-personal",
        controller,
        stopSessions: Effect.void,
        randomOwnerId: Effect.succeed("owner"),
      });

      const attempt = yield* actions.start("antigravity_google");
      expect(attempt.authorizationUrl).toBe(codeAuthorizationUrl);
      expect(attempt.authorizationResponseKind).toBe("code");
      if (!attempt.submitAuthorizationCode) {
        return yield* Effect.die("Expected the Antigravity code handoff.");
      }
      yield* attempt.submitAuthorizationCode("4/0Afixture-code");
      yield* attempt.waitForCompletion;

      expect(calls).toEqual([
        "respond:scient-provider-lifecycle-owner:flow-cli:flow-cli",
        JSON.stringify({ type: "credentials", values: { code: "4/0Afixture-code" } }),
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

it.effect("fails when the auth controller closes before providing the initial browser link", () =>
  Effect.gen(function* () {
    const cancelled: string[] = [];
    const controller: ProviderAuthController = {
      start: () => Effect.succeed(authState("starting", { flowId: "closed-flow" })),
      complete: () => Effect.die("Closed auth must not receive a callback."),
      cancel: (_owner, flowId) =>
        Effect.sync(() => {
          cancelled.push(flowId);
          return authState("cancelled", { flowId });
        }),
      logout: () => Effect.succeed(authState("idle")),
      subscribe: () => Stream.empty,
    };
    const actions = makeAntigravityConnectionActionsFromController({
      instanceId,
      authMethod: "oauth-personal",
      controller,
      stopSessions: Effect.void,
      randomOwnerId: Effect.succeed("closed-owner"),
    });
    const result = yield* actions.start("antigravity_google").pipe(Effect.scoped, Effect.result);
    expect(result._tag).toBe("Failure");
    expect(cancelled).toEqual(["closed-flow"]);
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
      compatibility: () => Effect.undefined,
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
      checkForUpdate: Effect.void,
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
      compatibility: () => Effect.undefined,
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
      checkForUpdate: Effect.void,
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
      .run(
        "repair",
        plan.catalogRevision,
        (update) => Effect.sync(() => progress.push(update.status)),
        Effect.void,
      )
      .pipe(Effect.flip);

    expect(error.message).toContain("failed verification");
    expect(starts).toBe(1);
    expect(removes).toBe(0);
    expect(progress).toEqual(["downloading", "preparing"]);
    current = { ...newest, sha256: "8".repeat(64) };
    expect(
      (yield* actions
        .run("repair", plan.catalogRevision, () => Effect.void, Effect.void)
        .pipe(Effect.flip)).message,
    ).toContain("plan changed");
    expect(starts).toBe(1);
    const removePlan = yield* actions.plan("remove");
    current = null; // Removal does not depend on the download catalog.
    yield* actions.run("remove", removePlan.catalogRevision, () => Effect.void, Effect.void);
    expect(removes).toBe(1);
    expect(refreshes).toBe(1);
  }),
);

it.effect("offers the agy CLI as the update for a paired runtime and never back again", () =>
  Effect.gen(function* () {
    const paired = bundledAntigravityAcpAsset("linux", "x64")!;
    const cliRelease = (version: string) => ({
      version,
      url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-1/linux-x64/cli_linux_x64.tar.gz`,
      sha512: version.replaceAll(".", "").padEnd(128, "a"),
      archiveBytes: 56_000_000,
      executable: { name: "antigravity" },
      format: "tar.gz" as const,
    });
    const state = {
      latest: cliRelease("1.5.14") as AntigravityManagedRelease,
      installed: {
        harnessPath: "/managed/localharness_external" as string | null,
        version: "1.4.5",
      },
    };
    const started: AntigravityManagedRelease[] = [];
    const installation = AntigravityInstallation.of({
      managedDirectory: "/managed/antigravity",
      compatibility: () => Effect.undefined,
      latestRelease: Effect.sync(() => state.latest),
      refreshLatestRelease: Effect.sync(() => state.latest),
      resolve: () =>
        Effect.sync(() => ({
          executablePath: "/managed/runtime",
          harnessPath: state.installed.harnessPath,
          source: "managed" as const,
          version: state.installed.version,
          managedVersionDirectory: "/managed/antigravity/versions/current",
        })),
      acquire: () => Effect.die("not used"),
      start: Effect.die("Use the exact reviewed release"),
      startRelease: (asset) =>
        Effect.sync(() => {
          started.push(asset);
          return installState("downloading", { operationId: "switch", version: asset.version });
        }),
      checkForUpdate: Effect.void,
      cancel: () => Effect.die("not used"),
      state: Effect.sync(() => installState("idle", { installedVersion: state.installed.version })),
      changes: Stream.make(installState("succeeded", { operationId: "switch" })),
      remove: () => Effect.die("not used"),
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
      protectedBinaryPaths: Effect.succeed([]),
    });

    const fromPaired = yield* actions.getSummary;
    expect(fromPaired).toMatchObject({
      actions: ["update", "repair", "remove"],
      availableManagedVersion: "1.5.14",
    });
    expect(fromPaired.message).toContain("sign in to Google again");
    const plan = yield* actions.plan("update");
    expect(plan).toMatchObject({
      version: "1.5.14",
      downloadBytes: 56_000_000,
      sourceLabel: "Official Google Antigravity CLI release",
      catalogRevision: `antigravity-cli:1.5.14:${cliRelease("1.5.14").sha512}`,
    });
    expect(plan.message).toContain("sign in to Google again");
    yield* actions.run("update", plan.catalogRevision, () => Effect.void, Effect.void);
    expect(started).toEqual([cliRelease("1.5.14")]);

    // An installed CLI is never offered the paired release, not even as a repair.
    state.installed = { harnessPath: null, version: "1.5.14" };
    state.latest = paired;
    expect(yield* actions.getSummary).toMatchObject({
      actions: ["remove"],
      availableManagedVersion: null,
    });
    // A newer CLI is an ordinary update; the same one is a repair.
    state.latest = cliRelease("1.5.20");
    expect((yield* actions.getSummary).actions).toEqual(["update", "repair", "remove"]);
    state.latest = cliRelease("1.5.14");
    const current = yield* actions.getSummary;
    expect(current.actions).toEqual(["repair", "remove"]);
    expect(current.message).not.toContain("sign in");
    expect((yield* actions.plan("repair")).message).not.toContain("sign in");
  }),
);

it.effect("tells a session failure after Google accepted the sign-in from a failed sign-in", () =>
  Effect.gen(function* () {
    const controllerWith = (states: ReadonlyArray<ProviderAuthState>): ProviderAuthController => ({
      start: () => Effect.succeed(authState("starting", { flowId: "flow" })),
      complete: () => Effect.die("No callback in this test."),
      cancel: (_owner, flowId) => Effect.succeed(authState("cancelled", { flowId })),
      logout: () => Effect.succeed(authState("idle")),
      subscribe: () => Stream.fromIterable(states),
    });
    const startWith = (states: ReadonlyArray<ProviderAuthState>) =>
      makeAntigravityConnectionActionsFromController({
        instanceId,
        authMethod: "oauth-personal",
        controller: controllerWith(states),
        stopSessions: Effect.void,
        randomOwnerId: Effect.succeed("owner"),
      });

    const actions = startWith([]);
    expect(actions.startingMessage).toBe("Antigravity can take up to a minute to start.");

    // A stored sign-in: authentication passes at once and session/new fails before any link.
    const beforeLink = yield* startWith([
      authState("failed", { flowId: "flow", message: ANTIGRAVITY_SESSION_SETUP_FAILED_MESSAGE }),
    ])
      .start("antigravity_google")
      .pipe(Effect.scoped, Effect.flip);
    expect(beforeLink).toMatchObject({
      message: ANTIGRAVITY_SESSION_SETUP_FAILED_MESSAGE,
      afterSignIn: true,
    });

    // A browser sign-in that Google accepted, followed by the same failure.
    const attempt = yield* startWith([
      authState("waiting", { flowId: "flow", authorizationUrl }),
      authState("failed", { flowId: "flow", message: ANTIGRAVITY_SESSION_SETUP_FAILED_MESSAGE }),
    ]).start("antigravity_google");
    expect(yield* attempt.waitForCompletion.pipe(Effect.flip)).toMatchObject({
      message: ANTIGRAVITY_SESSION_SETUP_FAILED_MESSAGE,
      afterSignIn: true,
    });

    const declined = yield* startWith([
      authState("waiting", { flowId: "flow", authorizationUrl }),
      authState("failed", {
        flowId: "flow",
        message: "Google sign-in failed. Start sign-in again.",
      }),
    ]).start("antigravity_google");
    const plain = yield* declined.waitForCompletion.pipe(Effect.flip);
    expect(plain.message).toBe("Google sign-in failed. Start sign-in again.");
    expect(plain.afterSignIn).toBeUndefined();
  }).pipe(Effect.scoped),
);

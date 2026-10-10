import type { SdkLoginOptions, StoredSdkCredentials } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeCursorAuth } from "../../provider/CursorAuth.ts";
import { InMemoryCredentialStore } from "../../provider/cursorSdk.ts";
import { makeCursorSdkConnectionActions } from "./CursorSdkConnectionActions.ts";

const authorizationUrl = "https://cursor.com/loginDeepControl?challenge=test-only";
const credentials: StoredSdkCredentials = {
  version: 1,
  backendUrl: "https://api2.cursor.sh",
  apiKey: "synthetic-browser-key",
  createdAtMs: 0,
  apiKeyExpiresAtMs: 4_000_000_000_000,
  email: "cursor@example.com",
};

const makeHarness = Effect.fn("makeCursorConnectionHarness")(function* (showUrl = true) {
  const store = new InMemoryCredentialStore();
  const started = Promise.withResolvers<SdkLoginOptions>();
  const finish = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const changes: boolean[] = [];
  const auth = yield* makeCursorAuth({
    instanceId: ProviderInstanceId.make("cursor-test"),
    displayName: "Test Cursor",
    enabled: true,
    store,
    onChanged: (signedIn) => Effect.sync(() => void changes.push(signedIn)),
    login: async (options) => {
      if (showUrl) options.onLoginUrl?.(authorizationUrl);
      started.resolve(options);
      await finish.promise;
      await options.store?.save(credentials);
      returned.resolve();
      return { apiKey: credentials.apiKey, apiKeyExpiresAtMs: credentials.apiKeyExpiresAtMs! };
    },
  });
  const actions = yield* makeCursorSdkConnectionActions(auth.controller);
  return { auth, actions, store, started, finish, returned, changes };
});

it.layer(NodeServices.layer)("Cursor SDK connection actions", (it) => {
  it.effect("exposes the SDK URL and completes with the instance-owned credential", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const attempt = yield* harness.actions.start("cursor_browser");
      expect(attempt).toMatchObject({
        initialStatus: "waiting_for_browser",
        authorizationUrl,
        authorizationUrlKind: "primary",
      });
      expect((yield* Effect.promise(() => harness.started.promise)).openBrowser).toBe(false);
      expect(yield* harness.auth.readApiKey).toBeUndefined();
      yield* Effect.sync(() => harness.finish.resolve());
      yield* attempt.waitForCompletion;
      expect(yield* harness.auth.readApiKey).toBe(credentials.apiKey);
      expect(harness.changes).toEqual([true]);
      yield* harness.actions.disconnect;
      expect(yield* harness.auth.readApiKey).toBeUndefined();
      expect(harness.changes).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("closing only the attempt scope cancels login and discards a late SDK result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const attemptScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(attemptScope, Exit.void));
      const attempt = yield* harness.actions
        .start("cursor_browser")
        .pipe(Effect.provideService(Scope.Scope, attemptScope));
      const login = yield* Effect.promise(() => harness.started.promise);
      yield* Scope.close(attemptScope, Exit.void);
      expect(login.signal?.aborted).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(attempt.waitForCompletion))).toBe(true);
      yield* Effect.sync(() => harness.finish.resolve());
      yield* Effect.promise(() => harness.returned.promise);
      expect(yield* harness.auth.readApiKey).toBeUndefined();
      expect(harness.changes).toEqual([]);
      const retry = yield* harness.actions.start("cursor_browser");
      yield* retry.waitForCompletion;
      expect(yield* harness.auth.readApiKey).toBe(credentials.apiKey);
    }).pipe(Effect.scoped),
  );

  it.effect("owns cancellation before the SDK has supplied a browser URL", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(false);
      const attemptScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(attemptScope, Exit.void));
      const starting = yield* harness.actions
        .start("cursor_browser")
        .pipe(Effect.provideService(Scope.Scope, attemptScope), Effect.forkScoped);
      const login = yield* Effect.promise(() => harness.started.promise);
      yield* Scope.close(attemptScope, Exit.void);
      expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true);
      expect(login.signal?.aborted).toBe(true);
      yield* Effect.sync(() => harness.finish.resolve());
      yield* Effect.promise(() => harness.returned.promise);
      expect(yield* harness.auth.readApiKey).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("times out URL startup and releases the SDK login through the attempt scope", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(false);
      const starting = yield* harness.actions
        .start("cursor_browser")
        .pipe(Effect.scoped, Effect.result, Effect.forkScoped);
      const login = yield* Effect.promise(() => harness.started.promise);
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(starting);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("sign-in page");
      expect(login.signal?.aborted).toBe(true);
      expect(yield* harness.auth.controller.isChangingCredentials!).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("handles SDK completion without a browser URL", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(false);
      yield* Effect.sync(() => harness.finish.resolve());
      const attempt = yield* harness.actions.start("cursor_browser");
      expect(attempt.initialStatus).toBe("verifying");
      expect(attempt.authorizationUrl).toBeUndefined();
      yield* attempt.waitForCompletion;
      expect(yield* harness.auth.readApiKey).toBe(credentials.apiKey);
    }).pipe(Effect.scoped),
  );

  it.effect("reports an SDK failure through Scient's completion path", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const attempt = yield* harness.actions.start("cursor_browser");
      yield* Effect.sync(() => harness.finish.reject(new Error("synthetic login failure")));
      const result = yield* Effect.result(attempt.waitForCompletion);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("failed or expired");
      expect(yield* harness.auth.readApiKey).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unsupported methods without starting SDK authentication", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* Effect.result(harness.actions.start("codex_browser"));
      expect(result._tag).toBe("Failure");
      expect(yield* harness.auth.controller.isChangingCredentials!).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("does not wait forever after the SDK auth owner is signed out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const attempt = yield* harness.actions.start("cursor_browser");
      yield* harness.actions.disconnect;
      const result = yield* Effect.result(attempt.waitForCompletion);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("no longer active");
      expect(yield* harness.auth.readApiKey).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});

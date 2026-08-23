import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import {
  makeGrokConnectionActionsFromRuntime,
  type GrokConnectionRuntime,
  withGrokSessionShutdown,
} from "./GrokConnectionActions.ts";

describe("Grok connection actions", () => {
  it.effect("runs the official browser flow and returns a loopback authorization code", () =>
    Effect.gen(function* () {
      const connected = yield* Ref.make(false);
      const authenticateDone = yield* Deferred.make<void>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (value: string) => Ref.update(events, (current) => [...current, value]);
      const runtime: GrokConnectionRuntime = {
        open: (deviceFlow) =>
          Effect.succeed({
            initialize: () =>
              Ref.get(connected).pipe(
                Effect.map((isConnected) => ({
                  protocolVersion: 1,
                  authMethods: [
                    ...(isConnected ? [{ id: "cached_token", name: "Connected account" }] : []),
                    { id: "grok.com", name: "Grok account" },
                  ],
                })),
              ),
            authenticate: (payload) =>
              record(
                `authenticate:${payload.methodId}:${deviceFlow}:${String(payload._meta?.use_oauth)}`,
              ).pipe(Effect.andThen(Deferred.await(authenticateDone)), Effect.as({})),
            request: (method, payload) =>
              record(method).pipe(
                Effect.andThen(
                  method === "_x.ai/auth/get_url"
                    ? Effect.succeed({
                        auth_url: "https://accounts.x.ai/oauth/callback",
                        external_provider: false,
                        mode: "loopback",
                      })
                    : method === "_x.ai/auth/submit_code"
                      ? Ref.set(connected, true).pipe(
                          Effect.andThen(Deferred.succeed(authenticateDone, undefined)),
                          Effect.as(payload),
                        )
                      : Effect.succeed({ cancelled: true }),
                ),
              ),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const attempt = yield* actions.start("grok_account");

      expect(attempt.authorizationUrl).toBe("https://accounts.x.ai/oauth/callback");
      expect(attempt.authorizationUrlKind).toBe("manual_fallback");
      expect(attempt.submitAuthorizationCode).toBeDefined();
      yield* attempt.submitAuthorizationCode!("one-time-code");
      yield* attempt.waitForCompletion;
      expect(yield* Ref.get(connected)).toBe(true);
      expect(new Set(yield* Ref.get(events))).toEqual(
        new Set([
          "authenticate:grok.com:false:true",
          "_x.ai/auth/get_url",
          "_x.ai/auth/submit_code",
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("exposes the provider device code without inventing a paste-code step", () =>
    Effect.gen(function* () {
      const connected = yield* Ref.make(false);
      const authenticateDone = yield* Deferred.make<void>();
      const useOauth = yield* Deferred.make<unknown>();
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Ref.get(connected).pipe(
                Effect.map((isConnected) => ({
                  protocolVersion: 1,
                  authMethods: [
                    ...(isConnected ? [{ id: "cached_token", name: "Connected account" }] : []),
                    { id: "grok.com", name: "Grok account" },
                  ],
                })),
              ),
            authenticate: (payload) =>
              Deferred.succeed(useOauth, payload._meta?.use_oauth).pipe(
                Effect.andThen(Deferred.await(authenticateDone)),
                Effect.as({}),
              ),
            request: () =>
              Deferred.await(useOauth).pipe(
                Effect.as({
                  auth_url: "https://accounts.x.ai/device?user_code=GROK-1234",
                  external_provider: false,
                  mode: "device",
                }),
              ),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const attempt = yield* actions.start("grok_device_code");

      expect(attempt.userCode).toBe("GROK-1234");
      expect(attempt.authorizationUrlKind).toBe("manual_fallback");
      expect(attempt.submitAuthorizationCode).toBeUndefined();
      expect(yield* Deferred.await(useOauth)).toBe(false);
      yield* Ref.set(connected, true);
      yield* Deferred.succeed(authenticateDone, undefined);
      yield* attempt.waitForCompletion;
    }).pipe(Effect.scoped),
  );

  it.effect("bounds an authorization-code submission that never responds", () =>
    Effect.gen(function* () {
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Effect.succeed({
                protocolVersion: 1,
                authMethods: [{ id: "grok.com", name: "Grok account" }],
              }),
            authenticate: () => Effect.never,
            request: (method) =>
              method === "_x.ai/auth/get_url"
                ? Effect.succeed({
                    auth_url: "https://accounts.x.ai/oauth",
                    external_provider: false,
                    mode: "loopback",
                  })
                : method === "_x.ai/auth/submit_code"
                  ? Effect.never
                  : Effect.succeed({ cancelled: true }),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const attempt = yield* actions.start("grok_account");
      const resultFiber = yield* Effect.result(
        attempt.submitAuthorizationCode!("one-time-code"),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(resultFiber);
      yield* attempt.cancel;

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("cancels the exact in-flight request and interrupts authentication", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Effect.succeed({
                protocolVersion: 1,
                authMethods: [{ id: "grok.com", name: "Grok account" }],
              }),
            authenticate: () => Effect.never,
            request: (method, payload) =>
              Ref.update(events, (current) => [...current, { method, payload }]).pipe(
                Effect.as(
                  method === "_x.ai/auth/get_url"
                    ? {
                        auth_url: "https://accounts.x.ai/oauth",
                        external_provider: false,
                        mode: "loopback",
                      }
                    : { cancelled: true },
                ),
              ),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const attempt = yield* actions.start("grok_account");
      yield* attempt.cancel;

      expect(yield* Ref.get(events)).toEqual([
        { method: "_x.ai/auth/get_url", payload: {} },
        { method: "_x.ai/auth/cancel", payload: { request_seq: 1 } },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("accepts successful authentication that finishes before Grok publishes a URL", () =>
    Effect.gen(function* () {
      const connected = yield* Ref.make(false);
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Ref.get(connected).pipe(
                Effect.map((isConnected) => ({
                  protocolVersion: 1,
                  authMethods: [
                    ...(isConnected ? [{ id: "cached_token", name: "Connected account" }] : []),
                    { id: "grok.com", name: "Grok account" },
                  ],
                })),
              ),
            authenticate: () => Ref.set(connected, true).pipe(Effect.as({})),
            request: () => Effect.never,
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const attempt = yield* actions.start("grok_account");

      expect(attempt.authorizationUrl).toBeUndefined();
      yield* attempt.waitForCompletion;
      expect(yield* Ref.get(connected)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds account verification after immediate authentication", () =>
    Effect.gen(function* () {
      const opens = yield* Ref.make(0);
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Ref.updateAndGet(opens, (value) => value + 1).pipe(
            Effect.map((openCount) => ({
              initialize: () =>
                openCount === 1
                  ? Effect.succeed({
                      protocolVersion: 1,
                      authMethods: [{ id: "grok.com", name: "Grok account" }],
                    })
                  : Effect.never,
              authenticate: () => Effect.succeed({}),
              request: () => Effect.never,
            })),
          ),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const resultFiber = yield* Effect.result(actions.start("grok_account")).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust("20 seconds");
      const result = yield* Fiber.join(resultFiber);

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("fails promptly when authentication errors before Grok publishes a URL", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Effect.succeed({
                protocolVersion: 1,
                authMethods: [{ id: "grok.com", name: "Grok account" }],
              }),
            authenticate: () =>
              Effect.fail(
                new ProviderConnectionActionError({ message: "Synthetic auth failure." }),
              ),
            request: (method) =>
              Ref.update(events, (current) => [...current, method]).pipe(
                Effect.andThen(
                  method === "_x.ai/auth/get_url"
                    ? Effect.never
                    : Effect.succeed({ cancelled: true }),
                ),
              ),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const result = yield* Effect.result(actions.start("grok_account"));

      expect(result._tag).toBe("Failure");
      expect(yield* Ref.get(events)).toContain("_x.ai/auth/cancel");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an insecure authorization URL and cancels the exact request", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Effect.succeed({
                protocolVersion: 1,
                authMethods: [{ id: "grok.com", name: "Grok account" }],
              }),
            authenticate: () => Effect.never,
            request: (method, payload) =>
              Ref.update(events, (current) => [...current, { method, payload }]).pipe(
                Effect.as(
                  method === "_x.ai/auth/get_url"
                    ? {
                        auth_url: "http://accounts.x.ai/oauth",
                        external_provider: false,
                        mode: "loopback",
                      }
                    : { cancelled: true },
                ),
              ),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const result = yield* Effect.result(actions.start("grok_account"));

      expect(result._tag).toBe("Failure");
      expect(yield* Ref.get(events)).toEqual([
        { method: "_x.ai/auth/get_url", payload: {} },
        { method: "_x.ai/auth/cancel", payload: { request_seq: 1 } },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the official OIDC method when the account method is unavailable", () =>
    Effect.gen(function* () {
      const authenticateStarted = yield* Deferred.make<string>();
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Effect.succeed({
                protocolVersion: 1,
                authMethods: [{ id: "oidc", name: "xAI OIDC" }],
              }),
            authenticate: (payload) =>
              Deferred.succeed(authenticateStarted, payload.methodId).pipe(
                Effect.andThen(Effect.never),
              ),
            request: () =>
              Deferred.await(authenticateStarted).pipe(
                Effect.as({
                  auth_url: "https://accounts.x.ai/oauth",
                  external_provider: false,
                  mode: "loopback",
                }),
              ),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const attempt = yield* actions.start("grok_account");

      expect(yield* Deferred.await(authenticateStarted)).toBe("oidc");
      yield* attempt.cancel;
    }).pipe(Effect.scoped),
  );

  it.effect("times out and cancels a sign-in that never completes", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Effect.succeed({
                protocolVersion: 1,
                authMethods: [{ id: "grok.com", name: "Grok account" }],
              }),
            authenticate: () => Effect.never,
            request: (method, payload) =>
              Ref.update(events, (current) => [...current, { method, payload }]).pipe(
                Effect.as(
                  method === "_x.ai/auth/get_url"
                    ? {
                        auth_url: "https://accounts.x.ai/oauth",
                        external_provider: false,
                        mode: "loopback",
                      }
                    : { cancelled: true },
                ),
              ),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const attempt = yield* actions.start("grok_account");
      const resultFiber = yield* Effect.result(attempt.waitForCompletion).pipe(Effect.forkChild);

      yield* TestClock.adjust("10 minutes");
      const result = yield* Fiber.join(resultFiber);

      expect(result._tag).toBe("Failure");
      expect(yield* Ref.get(events)).toContainEqual({
        method: "_x.ai/auth/cancel",
        payload: { request_seq: 1 },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("bounds a sign-out request that never responds", () =>
    Effect.gen(function* () {
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Effect.succeed({
                protocolVersion: 1,
                authMethods: [{ id: "cached_token", name: "Connected account" }],
              }),
            authenticate: () => Effect.die("must not authenticate during sign out"),
            request: () => Effect.never,
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const resultFiber = yield* Effect.result(actions.disconnect).pipe(Effect.forkChild);

      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(resultFiber);

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("signs out through Grok and accepts a remaining API-key configuration", () =>
    Effect.gen(function* () {
      const connected = yield* Ref.make(true);
      const methods = yield* Ref.make<ReadonlyArray<string>>([]);
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Ref.get(connected).pipe(
                Effect.map((isConnected) => ({
                  protocolVersion: 1,
                  authMethods: isConnected
                    ? [{ id: "cached_token", name: "Connected account" }]
                    : [{ id: "xai.api_key", name: "xAI API key" }],
                })),
              ),
            authenticate: () => Effect.die("must not authenticate during sign out"),
            request: (method) =>
              Ref.update(methods, (current) => [...current, method]).pipe(
                Effect.andThen(Ref.set(connected, false)),
                Effect.as({ ok: true, was_logged_in: true, api_key_still_set: true }),
              ),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      yield* actions.disconnect;

      expect(yield* Ref.get(connected)).toBe(false);
      expect(yield* Ref.get(methods)).toEqual(["_x.ai/auth/logout"]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects sign out when Grok still advertises the connected account", () =>
    Effect.gen(function* () {
      const runtime: GrokConnectionRuntime = {
        open: () =>
          Effect.succeed({
            initialize: () =>
              Effect.succeed({
                protocolVersion: 1,
                authMethods: [{ id: "cached_token", name: "Connected account" }],
              }),
            authenticate: () => Effect.die("must not authenticate during sign out"),
            request: () => Effect.succeed({ ok: true, was_logged_in: true }),
          }),
      };
      const actions = yield* makeGrokConnectionActionsFromRuntime(runtime);
      const result = yield* Effect.result(actions.disconnect);

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unrelated provider methods before opening Grok", () =>
    Effect.gen(function* () {
      const actions = yield* makeGrokConnectionActionsFromRuntime({
        open: () => Effect.die("must not open"),
      });
      const result = yield* Effect.result(actions.start("codex_browser"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("stops active Grok sessions before signing out", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const actions = withGrokSessionShutdown(
        {
          methods: ["grok_account"],
          start: () => Effect.die("must not start"),
          disconnect: record("logout"),
        },
        record("stop-sessions"),
      );

      yield* actions.disconnect;
      expect(yield* Ref.get(events)).toEqual(["stop-sessions", "logout"]);
    }),
  );
});

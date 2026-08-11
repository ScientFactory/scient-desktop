import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexSchema from "effect-codex-app-server/schema";

import type { CodexAppServerConnection } from "../../provider/Layers/CodexProvider.ts";
import { makeCodexConnectionActionsFromOpen } from "./CodexConnectionActions.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

type LoginCompletedHandler = (
  notification: CodexSchema.V2AccountLoginCompletedNotification,
) => Effect.Effect<void>;
type AccountUpdatedHandler = (
  notification: CodexSchema.V2AccountUpdatedNotification,
) => Effect.Effect<void>;

class MockCodexClientError extends Schema.TaggedErrorClass<MockCodexClientError>()(
  "MockCodexClientError",
  { message: Schema.String },
) {}

function makeClient(options: {
  readonly loginResponse:
    | { readonly type: "chatgpt"; readonly loginId: string; readonly authUrl: string }
    | {
        readonly type: "chatgptDeviceCode";
        readonly loginId: string;
        readonly verificationUrl: string;
        readonly userCode: string;
      };
  readonly accountReads?: ReadonlyArray<{
    readonly account: boolean;
    readonly requiresOpenaiAuth?: boolean;
    readonly fail?: boolean;
  }>;
  readonly accountAfterLogin?: boolean;
}) {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const events: Array<string> = [];
  let completedHandler: LoginCompletedHandler | undefined;
  let updatedHandler: AccountUpdatedHandler | undefined;
  let accountReadIndex = 0;
  const accountReads =
    options.accountReads ??
    (options.accountAfterLogin === false
      ? [{ account: false, requiresOpenaiAuth: true }]
      : [{ account: true, requiresOpenaiAuth: true }]);

  const client = {
    handleServerNotification: (
      method: string,
      handler: LoginCompletedHandler | AccountUpdatedHandler,
    ) => {
      if (method === "account/login/completed") {
        events.push("subscribe:account/login/completed");
        completedHandler = handler as LoginCompletedHandler;
        return Effect.void;
      }
      if (method === "account/updated") {
        events.push("subscribe:account/updated");
        updatedHandler = handler as AccountUpdatedHandler;
        return Effect.void;
      }
      throw new Error(`Unexpected Codex notification subscription: ${method}`);
    },
    request: (method: string, params: unknown) =>
      Effect.gen(function* () {
        events.push(`request:${method}`);
        requests.push({ method, params });
        switch (method) {
          case "account/login/start":
            return options.loginResponse;
          case "account/login/cancel":
          case "account/logout":
            return {};
          case "account/read": {
            const next = accountReads[Math.min(accountReadIndex, accountReads.length - 1)]!;
            accountReadIndex += 1;
            if (next.fail) {
              return yield* new MockCodexClientError({ message: "Mock account/read failure" });
            }
            return {
              account: next.account
                ? { type: "chatgpt", email: "scientist@example.test", planType: "pro" }
                : null,
              requiresOpenaiAuth: next.requiresOpenaiAuth ?? true,
            };
          }
          default:
            return yield* new MockCodexClientError({
              message: `Unexpected Codex request: ${method}`,
            });
        }
      }),
  } as unknown as CodexAppServerConnection["client"];

  return {
    client,
    events,
    requests,
    notifyCompleted: (notification: CodexSchema.V2AccountLoginCompletedNotification) => {
      assert.ok(completedHandler, "Codex completion handler was not registered");
      return completedHandler(notification);
    },
    notifyUpdated: () => {
      assert.ok(updatedHandler, "Codex account/updated handler was not registered");
      return updatedHandler({});
    },
  };
}

function makeOpenSequence(...clients: ReadonlyArray<ReturnType<typeof makeClient>>) {
  let openCount = 0;
  return {
    open: Effect.sync(() => {
      const selected = clients[Math.min(openCount, clients.length - 1)];
      assert.ok(selected, "A mock Codex client is available for every open");
      openCount += 1;
      return { client: selected.client, version: "0.147.0" };
    }),
    get openCount() {
      return openCount;
    },
  };
}

describe("CodexConnectionActions", () => {
  it.effect("uses Codex's official browser login and verifies the completed account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const login = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "login-browser",
            authUrl: "https://auth.openai.com/authorize",
          },
          accountReads: [{ account: true }],
        });
        const fresh = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "unused-fresh-login",
            authUrl: "https://auth.openai.com/unused",
          },
          accountReads: [{ account: true }],
        });
        const opened = makeOpenSequence(login, fresh);
        const actions = makeCodexConnectionActionsFromOpen(opened.open);

        const attempt = yield* actions.start("codex_browser");
        assert.strictEqual(attempt.authorizationUrl, "https://auth.openai.com/authorize");
        assert.strictEqual(attempt.authorizationUrlKind, "primary");
        assert.strictEqual(attempt.userCode, undefined);
        assert.deepStrictEqual(login.requests[0], {
          method: "account/login/start",
          params: {
            type: "chatgpt",
            useHostedLoginSuccessPage: false,
          },
        });
        assert.deepStrictEqual(login.events.slice(0, 3), [
          "subscribe:account/login/completed",
          "subscribe:account/updated",
          "request:account/login/start",
        ]);

        yield* login.notifyCompleted({
          loginId: "unrelated-login",
          success: true,
          error: null,
        });
        yield* login.notifyCompleted({
          loginId: "login-browser",
          success: true,
          error: null,
        });
        yield* attempt.waitForCompletion;
        assert.strictEqual(opened.openCount, 2);
        assert.deepStrictEqual(login.requests.at(-1), {
          method: "account/read",
          params: { refreshToken: true },
        });
        assert.deepStrictEqual(fresh.requests, [
          { method: "account/read", params: { refreshToken: true } },
        ]);
        assert.deepStrictEqual(fresh.events, ["request:account/read"]);

        yield* attempt.cancel;
        assert.deepStrictEqual(login.requests.at(-1), {
          method: "account/login/cancel",
          params: { loginId: "login-browser" },
        });
      }),
    ),
  );

  it.effect("preserves the in-process account/read failure instead of reporting a timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const login = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "login-read-fail",
            authUrl: "https://auth.openai.com/authorize",
          },
          accountReads: [{ account: false, fail: true }],
        });
        const actions = makeCodexConnectionActionsFromOpen(
          Effect.succeed({ client: login.client, version: "0.147.0" }),
        );
        const attempt = yield* actions.start("codex_browser");
        yield* login.notifyCompleted({
          loginId: "login-read-fail",
          success: true,
          error: null,
        });

        const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.strictEqual(
          failure.message,
          "Codex signed in, but Scient could not verify the account.",
        );
      }),
    ),
  );

  it.effect(
    "reports the fresh-read failure message instead of a timeout when account/read fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const login = makeClient({
            loginResponse: {
              type: "chatgpt",
              loginId: "login-fresh-fail",
              authUrl: "https://auth.openai.com/authorize",
            },
            accountReads: [{ account: true }],
          });
          const fresh = makeClient({
            loginResponse: {
              type: "chatgpt",
              loginId: "unused-fresh-login",
              authUrl: "https://auth.openai.com/unused",
            },
            accountReads: [{ account: true, fail: true }],
          });
          const actions = makeCodexConnectionActionsFromOpen(makeOpenSequence(login, fresh).open);
          const attempt = yield* actions.start("codex_browser");
          yield* login.notifyCompleted({
            loginId: "login-fresh-fail",
            success: true,
            error: null,
          });
          const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
          // The mapError message must survive, not the timeoutOrElse message.
          assert.strictEqual(
            failure.message,
            "Codex signed in, but Scient could not confirm the account in a fresh Codex process.",
          );
        }),
      ),
  );

  it.effect("retries a fresh Codex process until its account store catches up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const login = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "login-fresh-retry",
            authUrl: "https://auth.openai.com/authorize",
          },
          accountReads: [{ account: true }],
        });
        const fresh = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "unused-fresh-login",
            authUrl: "https://auth.openai.com/unused",
          },
          accountReads: [{ account: false }, { account: true }],
        });
        const actions = makeCodexConnectionActionsFromOpen(makeOpenSequence(login, fresh).open);
        const attempt = yield* actions.start("codex_browser");
        yield* login.notifyCompleted({
          loginId: "login-fresh-retry",
          success: true,
          error: null,
        });
        const fiber = yield* Effect.forkChild(attempt.waitForCompletion);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("500 millis");
        yield* Fiber.join(fiber);

        assert.strictEqual(
          fresh.requests.filter((request) => request.method === "account/read").length,
          2,
        );
      }),
    ),
  );

  it.effect("bounds fresh-process account propagation after login succeeds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const login = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "login-fresh-timeout",
            authUrl: "https://auth.openai.com/authorize",
          },
          accountReads: [{ account: true }],
        });
        const fresh = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "unused-fresh-login",
            authUrl: "https://auth.openai.com/unused",
          },
          accountReads: [{ account: false }],
        });
        const actions = makeCodexConnectionActionsFromOpen(makeOpenSequence(login, fresh).open);
        const attempt = yield* actions.start("codex_browser");
        yield* login.notifyCompleted({
          loginId: "login-fresh-timeout",
          success: true,
          error: null,
        });

        const fiber = yield* Effect.forkChild(attempt.waitForCompletion.pipe(Effect.flip));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("20 seconds");
        const failure = yield* Fiber.join(fiber);

        assert.strictEqual(
          failure.message,
          "Codex signed in, but a fresh Codex process did not observe the account in time.",
        );
      }),
    ),
  );

  it.effect("reports when the fresh confirmation process cannot start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const login = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "login-fresh-open-fail",
            authUrl: "https://auth.openai.com/authorize",
          },
          accountReads: [{ account: true }],
        });
        let openCount = 0;
        const open = Effect.suspend(() => {
          openCount += 1;
          return openCount === 1
            ? Effect.succeed({ client: login.client, version: "0.147.0" })
            : Effect.fail(
                new ProviderConnectionActionError({
                  message: "Mock fresh-process startup failure",
                }),
              );
        });
        const actions = makeCodexConnectionActionsFromOpen(open);
        const attempt = yield* actions.start("codex_browser");
        yield* login.notifyCompleted({
          loginId: "login-fresh-open-fail",
          success: true,
          error: null,
        });

        const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.strictEqual(
          failure.message,
          "Codex signed in, but Scient could not start a fresh Codex process to confirm the account.",
        );
      }),
    ),
  );

  it.effect("fails deterministically when Codex never exposes the completed account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "login-account-timeout",
            authUrl: "https://auth.openai.com/authorize",
          },
          accountReads: [{ account: false }],
        });
        const actions = makeCodexConnectionActionsFromOpen(
          Effect.succeed({ client: fake.client, version: "0.147.0" }),
        );
        const attempt = yield* actions.start("codex_browser");
        yield* fake.notifyCompleted({
          loginId: "login-account-timeout",
          success: true,
          error: null,
        });
        const fiber = yield* Effect.forkChild(attempt.waitForCompletion.pipe(Effect.flip));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("20 seconds");
        const failure = yield* Fiber.join(fiber);

        assert.strictEqual(
          failure.message,
          "Codex reported sign-in completion, but the account was not ready in time.",
        );
      }),
    ),
  );

  it.effect("retries account/read after account/updated until Codex reports the account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const login = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "login-retry",
            authUrl: "https://auth.openai.com/authorize",
          },
          accountReads: [{ account: false }, { account: true }],
        });
        const fresh = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "unused-fresh-login",
            authUrl: "https://auth.openai.com/unused",
          },
          accountReads: [{ account: true }],
        });
        const actions = makeCodexConnectionActionsFromOpen(makeOpenSequence(login, fresh).open);
        const attempt = yield* actions.start("codex_browser");
        yield* login.notifyCompleted({
          loginId: "login-retry",
          success: true,
          error: null,
        });
        const fiber = yield* Effect.forkChild(attempt.waitForCompletion);
        // First read already observed unauthenticated; wake the retry loop.
        yield* login.notifyUpdated();
        yield* Fiber.join(fiber);
        assert.strictEqual(
          login.requests.filter((request) => request.method === "account/read").length,
          2,
        );
        assert.strictEqual(
          fresh.requests.filter((request) => request.method === "account/read").length,
          1,
        );
      }),
    ),
  );

  it.effect("returns the official device code and preserves Codex login failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = makeClient({
          loginResponse: {
            type: "chatgptDeviceCode",
            loginId: "login-device",
            verificationUrl: "https://auth.openai.com/device",
            userCode: "ABCD-EFGH",
          },
        });
        const actions = makeCodexConnectionActionsFromOpen(
          Effect.succeed({ client: fake.client, version: "0.147.0" }),
        );
        const attempt = yield* actions.start("codex_device_code");
        assert.strictEqual(attempt.authorizationUrl, "https://auth.openai.com/device");
        assert.strictEqual(attempt.authorizationUrlKind, "primary");
        assert.strictEqual(attempt.userCode, "ABCD-EFGH");

        yield* fake.notifyCompleted({
          loginId: "login-device",
          success: false,
          error: "The device code expired.",
        });
        const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.strictEqual(failure.message, "The device code expired.");
      }),
    ),
  );

  it.effect("signs out through Codex and verifies that no account remains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "unused",
            authUrl: "https://auth.openai.com/authorize",
          },
          accountAfterLogin: false,
        });
        const actions = makeCodexConnectionActionsFromOpen(
          Effect.succeed({ client: fake.client, version: "0.147.0" }),
        );

        yield* actions.disconnect;
        assert.deepStrictEqual(fake.requests, [
          { method: "account/logout", params: undefined },
          { method: "account/read", params: {} },
        ]);
      }),
    ),
  );
});

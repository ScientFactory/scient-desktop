import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as CodexSchema from "effect-codex-app-server/schema";

import type { CodexAppServerConnection } from "../../provider/Layers/CodexProvider.ts";
import { makeCodexConnectionActionsFromOpen } from "./CodexConnectionActions.ts";

type LoginCompletedHandler = (
  notification: CodexSchema.V2AccountLoginCompletedNotification,
) => Effect.Effect<void>;

function makeClient(options: {
  readonly loginResponse:
    | { readonly type: "chatgpt"; readonly loginId: string; readonly authUrl: string }
    | {
        readonly type: "chatgptDeviceCode";
        readonly loginId: string;
        readonly verificationUrl: string;
        readonly userCode: string;
      };
  readonly accountAfterLogin?: boolean;
}) {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  let completedHandler: LoginCompletedHandler | undefined;
  const client = {
    handleServerNotification: (method: string, handler: LoginCompletedHandler) => {
      assert.strictEqual(method, "account/login/completed");
      completedHandler = handler;
      return Effect.void;
    },
    request: (method: string, params: unknown) =>
      Effect.sync(() => {
        requests.push({ method, params });
        switch (method) {
          case "account/login/start":
            return options.loginResponse;
          case "account/login/cancel":
          case "account/logout":
            return {};
          case "account/read":
            return {
              account:
                options.accountAfterLogin === false
                  ? null
                  : { type: "chatgpt", email: "scientist@example.test", planType: "pro" },
              requiresOpenaiAuth: true,
            };
          default:
            throw new Error(`Unexpected Codex request: ${method}`);
        }
      }),
  } as unknown as CodexAppServerConnection["client"];

  return {
    client,
    requests,
    notifyCompleted: (notification: CodexSchema.V2AccountLoginCompletedNotification) => {
      assert.ok(completedHandler, "Codex completion handler was not registered");
      return completedHandler(notification);
    },
  };
}

describe("CodexConnectionActions", () => {
  it.effect("uses Codex's official browser login and verifies the completed account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = makeClient({
          loginResponse: {
            type: "chatgpt",
            loginId: "login-browser",
            authUrl: "https://auth.openai.com/authorize",
          },
        });
        const actions = makeCodexConnectionActionsFromOpen(
          Effect.succeed({ client: fake.client, version: "0.147.0" }),
        );

        const attempt = yield* actions.start("codex_browser");
        assert.strictEqual(attempt.authorizationUrl, "https://auth.openai.com/authorize");
        assert.strictEqual(attempt.userCode, undefined);
        assert.deepStrictEqual(fake.requests[0], {
          method: "account/login/start",
          params: {
            type: "chatgpt",
            useHostedLoginSuccessPage: false,
          },
        });

        yield* fake.notifyCompleted({
          loginId: "unrelated-login",
          success: true,
          error: null,
        });
        yield* fake.notifyCompleted({
          loginId: "login-browser",
          success: true,
          error: null,
        });
        yield* attempt.waitForCompletion;
        assert.deepStrictEqual(fake.requests.at(-1), {
          method: "account/read",
          params: { refreshToken: true },
        });

        yield* attempt.cancel;
        assert.deepStrictEqual(fake.requests.at(-1), {
          method: "account/login/cancel",
          params: { loginId: "login-browser" },
        });
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

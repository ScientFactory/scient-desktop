import type { CodexSettings, ProviderConnectionMethod } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { resolveCodexLaunchArgs } from "../../provider/Layers/codexLaunchArgs.ts";
import {
  type CodexAppServerConnection,
  openCodexAppServerConnection,
} from "../../provider/Layers/CodexProvider.ts";
import { type ProviderConnectionActions } from "../../provider/ProviderDriver.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

const connectionError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

function methodParams(method: ProviderConnectionMethod): CodexSchema.V2LoginAccountParams {
  switch (method) {
    case "codex_browser":
      return {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "chatgpt",
      };
    case "codex_device_code":
      return { type: "chatgptDeviceCode" };
  }
}

const waitForLogin = Effect.fn("CodexConnectionActions.waitForLogin")(function* (
  notifications: Queue.Queue<CodexSchema.V2AccountLoginCompletedNotification>,
  loginId: string,
) {
  while (true) {
    const notification = yield* Queue.take(notifications);
    if (notification.loginId === loginId) {
      return notification;
    }
  }
});

/**
 * Codex-owned auth implementation. Scient starts and observes the official
 * app-server flow; Codex persists and refreshes its own credentials.
 */
export function makeCodexConnectionActionsFromOpen(
  open: Effect.Effect<CodexAppServerConnection, ProviderConnectionActionError, Scope.Scope>,
): ProviderConnectionActions {
  return {
    methods: ["codex_browser", "codex_device_code"],
    start: (method) =>
      Effect.gen(function* () {
        const { client } = yield* open;
        const notifications =
          yield* Queue.unbounded<CodexSchema.V2AccountLoginCompletedNotification>();
        yield* client.handleServerNotification("account/login/completed", (notification) =>
          Queue.offer(notifications, notification).pipe(Effect.asVoid),
        );
        const response = yield* client
          .request("account/login/start", methodParams(method))
          .pipe(
            Effect.mapError((cause) =>
              connectionError("Codex did not start its secure sign-in flow.", cause),
            ),
          );

        const expectedType = method === "codex_browser" ? "chatgpt" : "chatgptDeviceCode";
        if (response.type !== expectedType) {
          return yield* connectionError("Codex returned an unexpected sign-in response.");
        }

        const loginId = response.loginId;
        const waitForCompletion = Effect.gen(function* () {
          const completed = yield* waitForLogin(notifications, loginId);
          if (!completed.success) {
            return yield* connectionError(completed.error ?? "Codex sign in was not completed.");
          }
          const account = yield* client
            .request("account/read", { refreshToken: true })
            .pipe(
              Effect.mapError((cause) =>
                connectionError("Codex signed in, but Scient could not verify the account.", cause),
              ),
            );
          if (!account.account && account.requiresOpenaiAuth) {
            return yield* connectionError(
              "Codex did not report an authenticated account after sign in.",
            );
          }
        });

        const cancel = client.request("account/login/cancel", { loginId }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            connectionError("Codex could not cancel the active sign-in flow.", cause),
          ),
        );

        return response.type === "chatgpt"
          ? {
              authorizationUrl: response.authUrl,
              waitForCompletion,
              cancel,
            }
          : {
              authorizationUrl: response.verificationUrl,
              userCode: response.userCode,
              waitForCompletion,
              cancel,
            };
      }),
    disconnect: Effect.gen(function* () {
      const { client } = yield* open;
      yield* client
        .request("account/logout", undefined)
        .pipe(Effect.mapError((cause) => connectionError("Codex could not sign out.", cause)));
      const account = yield* client
        .request("account/read", {})
        .pipe(
          Effect.mapError((cause) =>
            connectionError("Codex signed out, but Scient could not verify it.", cause),
          ),
        );
      if (account.account) {
        return yield* connectionError("Codex still reports a connected account.");
      }
    }),
  };
}

export function makeCodexConnectionActions(
  settings: CodexSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ProviderConnectionActions {
  const open = openCodexAppServerConnection({
    binaryPath: settings.binaryPath,
    homePath: settings.homePath,
    launchArgs: resolveCodexLaunchArgs(settings.launchArgs, environment),
    cwd,
    environment,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => connectionError("Scient could not start Codex sign in.", cause)),
  );
  return makeCodexConnectionActionsFromOpen(open);
}

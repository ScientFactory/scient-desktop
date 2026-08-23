import type { CodexSettings, ProviderConnectionMethod } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
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

const LOGIN_ACCOUNT_VERIFY_TIMEOUT = Duration.seconds(20);
const LOGIN_ACCOUNT_POLL_INTERVAL = Duration.millis(500);
const FRESH_PROCESS_VERIFY_TIMEOUT = Duration.seconds(20);

const connectionError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

function methodParams(
  method: Extract<ProviderConnectionMethod, "codex_browser" | "codex_device_code">,
): CodexSchema.V2LoginAccountParams {
  switch (method) {
    case "codex_browser":
      return {
        type: "chatgpt",
        // Codex's hosted success page is an app handoff for Codex/ChatGPT.
        // Scient keeps the official local Codex callback page instead, which
        // confirms completion without trying to open a different application.
        useHostedLoginSuccessPage: false,
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

function isAuthenticatedAccount(account: {
  readonly account?: unknown;
  readonly requiresOpenaiAuth: boolean;
}): boolean {
  return Boolean(account.account) || !account.requiresOpenaiAuth;
}

/**
 * Retry account/read until Codex reports an authenticated account or the
 * bounded timeout elapses. `account/updated` only wakes the loop early —
 * authenticated account/read remains the success condition.
 */
const waitForAuthenticatedAccount = Effect.fn("CodexConnectionActions.waitForAuthenticatedAccount")(
  function* (client: CodexAppServerConnection["client"], accountUpdated: Queue.Queue<void>) {
    const readAccount = client
      .request("account/read", { refreshToken: true })
      .pipe(
        Effect.mapError((cause) =>
          connectionError("Codex signed in, but Scient could not verify the account.", cause),
        ),
      );

    const poll = Effect.gen(function* () {
      while (true) {
        const account = yield* readAccount;
        if (isAuthenticatedAccount(account)) return account;
        yield* Effect.raceAll([
          Queue.take(accountUpdated).pipe(Effect.asVoid),
          Effect.sleep(LOGIN_ACCOUNT_POLL_INTERVAL),
        ]);
      }
    });

    // Only the timeout is re-labeled; a failing account/read keeps its own
    // message instead of being reported as "not ready in time".
    return yield* poll.pipe(
      Effect.timeoutOrElse({
        duration: LOGIN_ACCOUNT_VERIFY_TIMEOUT,
        orElse: () =>
          Effect.fail(
            connectionError(
              "Codex reported sign-in completion, but the account was not ready in time.",
            ),
          ),
      }),
    );
  },
);

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
        if (method !== "codex_browser" && method !== "codex_device_code") {
          return yield* connectionError("Codex does not support this sign-in method.");
        }
        const { client } = yield* open;
        const completedNotifications =
          yield* Queue.unbounded<CodexSchema.V2AccountLoginCompletedNotification>();
        const accountUpdated = yield* Queue.unbounded<void>();
        yield* client.handleServerNotification("account/login/completed", (notification) =>
          Queue.offer(completedNotifications, notification).pipe(Effect.asVoid),
        );
        yield* client.handleServerNotification("account/updated", () =>
          Queue.offer(accountUpdated, void 0).pipe(Effect.asVoid),
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
          const completed = yield* waitForLogin(completedNotifications, loginId);
          if (!completed.success) {
            return yield* connectionError(completed.error ?? "Codex sign in was not completed.");
          }
          yield* waitForAuthenticatedAccount(client, accountUpdated);
          // Fresh-process verification: notifications and the login process are
          // wake-ups only. A new app-server must also observe the account.
          // Retry briefly — OS credential stores can lag the in-process read.
          const verifyFreshProcess = Effect.scoped(
            open.pipe(
              Effect.mapError((cause) =>
                connectionError(
                  "Codex signed in, but Scient could not start a fresh Codex process to confirm the account.",
                  cause,
                ),
              ),
              Effect.flatMap(({ client: freshClient }) => {
                const readFresh = freshClient
                  .request("account/read", { refreshToken: true })
                  .pipe(
                    Effect.mapError((cause) =>
                      connectionError(
                        "Codex signed in, but Scient could not confirm the account in a fresh Codex process.",
                        cause,
                      ),
                    ),
                  );
                return Effect.gen(function* () {
                  while (true) {
                    const account = yield* readFresh;
                    if (isAuthenticatedAccount(account)) return;
                    yield* Effect.sleep(LOGIN_ACCOUNT_POLL_INTERVAL);
                  }
                });
              }),
            ),
          );
          // Bound fresh process startup and account propagation together.
          // Only the timeout is re-labeled; open/read failures keep the more
          // specific messages above.
          yield* verifyFreshProcess.pipe(
            Effect.timeoutOrElse({
              duration: FRESH_PROCESS_VERIFY_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  connectionError(
                    "Codex signed in, but a fresh Codex process did not observe the account in time.",
                  ),
                ),
            }),
          );
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
              authorizationUrlKind: "primary" as const,
              initialStatus: "waiting_for_browser" as const,
              waitForCompletion,
              cancel,
            }
          : {
              authorizationUrl: response.verificationUrl,
              authorizationUrlKind: "primary" as const,
              initialStatus: "waiting_for_device_code" as const,
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

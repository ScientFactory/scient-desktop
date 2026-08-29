import type { ClaudeSettings, ProviderConnectionMethod } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeClaudeEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import { decodeClaudeAuthStatus } from "../../provider/Drivers/ClaudeAuthStatus.ts";
import type {
  ProviderConnectionActions,
  ProviderConnectionActionFailure,
} from "../../provider/ProviderDriver.ts";
import { spawnAndCollect } from "../../provider/providerSnapshot.ts";
import {
  findTerminalAuthorizationUrl,
  pickProcessEnvironment,
  ProviderConnectionActionError,
} from "./ProviderConnectionActions.ts";

const MAX_AUTH_OUTPUT_BYTES = 128 * 1024;
const AUTH_URL_TIMEOUT = "30 seconds";
const AUTH_LOGIN_TIMEOUT = "10 minutes";
const AUTH_STATUS_TIMEOUT = "15 seconds";
const AUTHORIZATION_CODE_MAX_LENGTH = 8_192;
const connectionError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

function isClaudeAuthorizationHost(hostname: string): boolean {
  return (
    hostname === "claude.ai" ||
    hostname.endsWith(".claude.ai") ||
    hostname === "claude.com" ||
    hostname.endsWith(".claude.com") ||
    hostname === "anthropic.com" ||
    hostname.endsWith(".anthropic.com")
  );
}

function isClaudeAuthorizationPath(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  return path.includes("oauth") || path.includes("authorize");
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function findClaudeAuthorizationUrl(output: string): string | undefined {
  return findTerminalAuthorizationUrl(
    output,
    (url) => isClaudeAuthorizationHost(url.hostname) && isClaudeAuthorizationPath(url),
  );
}

export interface ClaudeLoginProcess {
  readonly authorizationUrl: string;
  readonly submitAuthorizationCode: (
    code: string,
  ) => Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly waitForExit: Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly cancel: Effect.Effect<void, ProviderConnectionActionFailure>;
}

export interface ClaudeAuthRuntime {
  readonly startLogin: (
    method: "claude_subscription" | "claude_console",
  ) => Effect.Effect<ClaudeLoginProcess, ProviderConnectionActionFailure, Scope.Scope>;
  readonly verifyLoggedIn: Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly logout: Effect.Effect<void, ProviderConnectionActionFailure, Scope.Scope>;
}

/**
 * Provider-owned Claude authentication orchestration. Scient starts the
 * official Claude Code flow and supervises it; Claude Code alone stores,
 * refreshes, and revokes the resulting credentials.
 */
export function makeClaudeConnectionActionsFromRuntime(
  runtime: ClaudeAuthRuntime,
): ProviderConnectionActions {
  return {
    methods: ["claude_subscription", "claude_console"],
    start: (method: ProviderConnectionMethod) =>
      Effect.gen(function* () {
        if (method !== "claude_subscription" && method !== "claude_console") {
          return yield* connectionError("Claude does not support this sign-in method.");
        }
        const process = yield* runtime.startLogin(method);
        return {
          authorizationUrl: process.authorizationUrl,
          // Claude Code opens its localhost callback URL itself. The HTTPS URL
          // printed by the CLI is the provider's manual copy-code recovery,
          // not Scient's primary launch target.
          authorizationUrlKind: "manual_fallback",
          initialStatus: "waiting_for_browser",
          submitAuthorizationCode: process.submitAuthorizationCode,
          waitForCompletion: process.waitForExit.pipe(Effect.andThen(runtime.verifyLoggedIn)),
          cancel: process.cancel,
        };
      }),
    disconnect: runtime.logout,
  };
}

export function officialClaudeAccountEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowedKeys = [
    // Executable discovery, user-scoped credential storage, and temporary IO.
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMP",
    "TEMP",
    "TMPDIR",
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    // Windows executable discovery and credential storage.
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    // Locale and the host desktop/browser bridge used by the official flow.
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "BROWSER",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    // Enterprise network and trust configuration. These are connectivity
    // inputs, not provider credentials, and omitting them can make a valid
    // official login fail on managed networks.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ] as const;
  const result = pickProcessEnvironment(environment, allowedKeys);
  // Scient owns this private runtime version. Claude must not mutate it or
  // route around the reviewed artifact pipeline.
  result.DISABLE_UPDATES = "1";
  return result;
}

const runClaudeAuthCommand = Effect.fn("ClaudeConnectionActions.runAuthCommand")(function* (
  settings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  args: ReadonlyArray<string>,
) {
  const resolved = yield* resolveSpawnCommand(settings.binaryPath, args, {
    env: environment,
    extendEnv: false,
  });
  return yield* spawnAndCollect(
    settings.binaryPath,
    ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      extendEnv: false,
      shell: resolved.shell,
    }),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeoutOption(AUTH_STATUS_TIMEOUT),
  );
});

export const makeClaudeConnectionActions = Effect.fn("ClaudeConnectionActions.make")(function* (
  settings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.fn.Return<ProviderConnectionActions, never, Scope.Scope | import("effect/Path").Path> {
  const claudeEnvironment = officialClaudeAccountEnvironment(
    yield* makeClaudeEnvironment(settings, environment),
  );

  const verifyLoggedIn = runClaudeAuthCommand(settings, claudeEnvironment, spawner, [
    "auth",
    "status",
    "--json",
  ]).pipe(
    Effect.mapError((cause) =>
      connectionError("Claude signed in, but Scient could not verify the account.", cause),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(connectionError("Claude account verification timed out.")),
        onSome: (result) => {
          const status = decodeClaudeAuthStatus(result.stdout);
          return result.code === 0 && status?.loggedIn === true
            ? Effect.void
            : Effect.fail(connectionError("Claude did not report a connected account."));
        },
      }),
    ),
  );

  const startLogin: ClaudeAuthRuntime["startLogin"] = (method) =>
    Effect.gen(function* () {
      const args = ["auth", "login", method === "claude_subscription" ? "--claudeai" : "--console"];
      const resolved = yield* resolveSpawnCommand(settings.binaryPath, args, {
        env: claudeEnvironment,
        extendEnv: false,
      }).pipe(
        Effect.mapError((cause) =>
          connectionError("Scient could not prepare Claude sign in.", cause),
        ),
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            env: claudeEnvironment,
            extendEnv: false,
            shell: resolved.shell,
            stdin: { stream: "pipe", endOnDone: false },
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            connectionError("Scient could not start Claude sign in.", cause),
          ),
        );
      const cancel = child
        .kill({ forceKillAfter: "2 seconds" })
        .pipe(
          Effect.mapError((cause) =>
            connectionError("Claude sign in could not be cancelled.", cause),
          ),
        );
      const authorizationUrl = yield* Deferred.make<string, ProviderConnectionActionError>();
      const output = yield* Ref.make("");
      yield* child.all.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.updateAndGet(output, (current) =>
            `${current}${chunk}`.slice(-MAX_AUTH_OUTPUT_BYTES),
          ).pipe(
            Effect.flatMap((current) => {
              const url = findClaudeAuthorizationUrl(current);
              return url
                ? Deferred.succeed(authorizationUrl, url).pipe(Effect.asVoid)
                : Effect.void;
            }),
          ),
        ),
        Effect.catchCause(() =>
          Deferred.fail(
            authorizationUrl,
            connectionError("Claude sign in stopped before opening its secure page."),
          ).pipe(Effect.asVoid),
        ),
        Effect.forkScoped,
      );

      const exitedBeforeUrl = child.exitCode.pipe(
        Effect.flatMap(() =>
          Effect.fail(connectionError("Claude did not provide a secure sign-in page.")),
        ),
      );
      const url = yield* Effect.raceFirst(Deferred.await(authorizationUrl), exitedBeforeUrl).pipe(
        Effect.timeoutOption(AUTH_URL_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(connectionError("Claude took too long to open its sign-in page.")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.onError(() => cancel.pipe(Effect.ignore)),
      );

      const submitAuthorizationCode = (code: string) => {
        const normalized = code.trim();
        if (
          normalized.length === 0 ||
          normalized.length > AUTHORIZATION_CODE_MAX_LENGTH ||
          hasControlCharacters(normalized)
        ) {
          return Effect.fail(connectionError("Enter the one-time code shown by Claude."));
        }
        return Stream.run(Stream.encodeText(Stream.make(`${normalized}\n`)), child.stdin).pipe(
          Effect.mapError((cause) =>
            connectionError("Scient could not return the one-time code to Claude.", cause),
          ),
        );
      };

      const completed = child.exitCode.pipe(
        Effect.mapError((cause) => connectionError("Claude sign in stopped unexpectedly.", cause)),
        Effect.flatMap((code) =>
          Number(code) === 0
            ? Effect.void
            : Effect.fail(connectionError("Claude sign in was not completed.")),
        ),
      );
      const waitForExit = completed.pipe(
        Effect.timeoutOption(AUTH_LOGIN_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              cancel.pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.fail(
                    connectionError("Claude sign in took too long. Start sign in again."),
                  ),
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

      return { authorizationUrl: url, submitAuthorizationCode, waitForExit, cancel };
    });

  const logout = runClaudeAuthCommand(settings, claudeEnvironment, spawner, [
    "auth",
    "logout",
  ]).pipe(
    Effect.mapError((cause) => connectionError("Claude could not sign out.", cause)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(connectionError("Claude sign out timed out.")),
        onSome: (result) =>
          result.code === 0
            ? Effect.void
            : Effect.fail(connectionError("Claude could not sign out.")),
      }),
    ),
    Effect.andThen(
      runClaudeAuthCommand(settings, claudeEnvironment, spawner, ["auth", "status", "--json"]).pipe(
        Effect.mapError((cause) =>
          connectionError("Claude signed out, but Scient could not verify it.", cause),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(connectionError("Claude sign-out verification timed out.")),
            onSome: (result) => {
              const status = decodeClaudeAuthStatus(result.stdout);
              return status?.loggedIn === false
                ? Effect.void
                : Effect.fail(connectionError("Claude still reports a connected account."));
            },
          }),
        ),
      ),
    ),
  );

  return makeClaudeConnectionActionsFromRuntime({ startLogin, verifyLoggedIn, logout });
});

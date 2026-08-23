import type { CursorSettings, ProviderConnectionMethod } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { cursorCliArgs } from "../../provider/Layers/CursorCli.ts";
import {
  parseCursorAboutOutput,
  runCursorAboutCommand,
} from "../../provider/Layers/CursorProvider.ts";
import type {
  ProviderConnectionActions,
  ProviderConnectionActionFailure,
} from "../../provider/ProviderDriver.ts";
import { spawnAndCollect } from "../../provider/providerSnapshot.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

const MAX_AUTH_OUTPUT_BYTES = 128 * 1024;
const AUTH_URL_TIMEOUT = "30 seconds";
const AUTH_LOGIN_TIMEOUT = "10 minutes";
const AUTH_STATUS_TIMEOUT = "20 seconds";
const ANSI_ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_BELL_CHARACTER = String.fromCharCode(7);
const ANSI_OSC_HYPERLINK = new RegExp(
  `${ANSI_ESCAPE_CHARACTER}\\]8;[^;]*;(https:\\/\\/[^${ANSI_BELL_CHARACTER}${ANSI_ESCAPE_CHARACTER}]*)` +
    `(?:${ANSI_BELL_CHARACTER}|${ANSI_ESCAPE_CHARACTER}\\\\)`,
  "gu",
);
const ANSI_OSC_SEQUENCE = new RegExp(
  `${ANSI_ESCAPE_CHARACTER}\\][^${ANSI_BELL_CHARACTER}]*(?:${ANSI_BELL_CHARACTER}|${ANSI_ESCAPE_CHARACTER}\\\\)`,
  "gu",
);
const ANSI_ESCAPE = new RegExp(`${ANSI_ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, "gu");
const URL_CANDIDATE = /https:\/\/[^\s<>"']+/gu;

const connectionError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

function isCursorAuthorizationUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return (
    url.protocol === "https:" &&
    (hostname === "cursor.com" || hostname.endsWith(".cursor.com")) &&
    (path.includes("login") || path.includes("auth"))
  );
}

export function findCursorAuthorizationUrl(output: string): string | undefined {
  const normalized = output
    .replace(ANSI_OSC_HYPERLINK, "$1 ")
    .replace(ANSI_OSC_SEQUENCE, "")
    .replace(ANSI_ESCAPE, "");
  for (const match of normalized.matchAll(URL_CANDIDATE)) {
    const candidate = match[0]?.replace(/[),.;]+$/u, "");
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (isCursorAuthorizationUrl(url)) return url.toString();
    } catch {
      // Continue scanning provider-controlled output.
    }
  }
  return undefined;
}

export interface CursorLoginProcess {
  readonly authorizationUrl: string;
  readonly waitForExit: Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly cancel: Effect.Effect<void, ProviderConnectionActionFailure>;
}

export interface CursorAuthRuntime {
  readonly startLogin: Effect.Effect<
    CursorLoginProcess,
    ProviderConnectionActionFailure,
    Scope.Scope
  >;
  readonly verifyLoggedIn: Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly logout: Effect.Effect<void, ProviderConnectionActionFailure, Scope.Scope>;
}

export function makeCursorConnectionActionsFromRuntime(
  runtime: CursorAuthRuntime,
): ProviderConnectionActions {
  return {
    methods: ["cursor_browser"],
    start: (method: ProviderConnectionMethod) =>
      Effect.gen(function* () {
        if (method !== "cursor_browser") {
          return yield* connectionError("Cursor does not support this sign-in method.");
        }
        const process = yield* runtime.startLogin;
        return {
          initialStatus: "waiting_for_browser" as const,
          authorizationUrl: process.authorizationUrl,
          authorizationUrlKind: "primary" as const,
          waitForCompletion: process.waitForExit.pipe(Effect.andThen(runtime.verifyLoggedIn)),
          cancel: process.cancel,
        };
      }),
    disconnect: runtime.logout,
  };
}

export function withCursorSessionShutdown<E>(
  actions: ProviderConnectionActions,
  stopAll: Effect.Effect<void, E>,
): ProviderConnectionActions {
  return {
    ...actions,
    disconnect: stopAll.pipe(
      Effect.mapError((cause) =>
        connectionError("Scient could not stop active Cursor sessions before sign out.", cause),
      ),
      Effect.andThen(actions.disconnect),
    ),
  };
}

export function officialCursorAccountEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMP",
    "TEMP",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
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
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
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
    "SCIENT_MANAGED_CURSOR_RUNTIME",
  ] as const;
  const allowedNames = new Set(allowedKeys.map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => value !== undefined && allowedNames.has(key.toLowerCase()),
    ),
  );
}

const runCursorLifecycleCommand = Effect.fn("CursorConnectionActions.runCommand")(function* (
  settings: CursorSettings,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  args: ReadonlyArray<string>,
) {
  const resolved = yield* resolveSpawnCommand(
    settings.binaryPath,
    cursorCliArgs(args, environment),
    { env: environment, extendEnv: false },
  );
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

export const makeCursorConnectionActions = Effect.fn("CursorConnectionActions.make")((
  settings: CursorSettings,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<ProviderConnectionActions> => {
  const accountEnvironment = officialCursorAccountEnvironment(environment);
  const verifyAbout = runCursorAboutCommand(settings, accountEnvironment).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeoutOption(AUTH_STATUS_TIMEOUT),
    Effect.mapError((cause) =>
      connectionError("Scient could not verify the Cursor account.", cause),
    ),
  );

  const verifyLoggedIn = verifyAbout.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(connectionError("Cursor account verification timed out.")),
        onSome: (result) => {
          const parsed = parseCursorAboutOutput(result);
          return parsed.auth.status === "authenticated"
            ? Effect.void
            : Effect.fail(connectionError("Cursor did not report a connected account."));
        },
      }),
    ),
  );

  const startLogin: CursorAuthRuntime["startLogin"] = Effect.gen(function* () {
    const loginEnvironment = { ...accountEnvironment, NO_OPEN_BROWSER: "1" };
    const resolved = yield* resolveSpawnCommand(
      settings.binaryPath,
      cursorCliArgs(["login"], loginEnvironment),
      { env: loginEnvironment, extendEnv: false },
    ).pipe(
      Effect.mapError((cause) =>
        connectionError("Scient could not prepare Cursor sign in.", cause),
      ),
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          env: loginEnvironment,
          extendEnv: false,
          shell: resolved.shell,
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          connectionError("Scient could not start Cursor sign in.", cause),
        ),
      );
    const cancel = child
      .kill({ forceKillAfter: "2 seconds" })
      .pipe(
        Effect.mapError((cause) =>
          connectionError("Cursor sign in could not be cancelled.", cause),
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
            const url = findCursorAuthorizationUrl(current);
            return url ? Deferred.succeed(authorizationUrl, url).pipe(Effect.asVoid) : Effect.void;
          }),
        ),
      ),
      Effect.catchCause(() =>
        Deferred.fail(
          authorizationUrl,
          connectionError("Cursor sign in stopped before opening its secure page."),
        ).pipe(Effect.asVoid),
      ),
      Effect.forkScoped,
    );

    const exitedBeforeUrl = child.exitCode.pipe(
      Effect.flatMap(() =>
        Effect.fail(connectionError("Cursor did not provide a secure sign-in page.")),
      ),
    );
    const url = yield* Effect.raceFirst(Deferred.await(authorizationUrl), exitedBeforeUrl).pipe(
      Effect.timeoutOption(AUTH_URL_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(connectionError("Cursor took too long to provide its sign-in page.")),
          onSome: Effect.succeed,
        }),
      ),
      Effect.onError(() => cancel.pipe(Effect.ignore)),
    );

    const waitForExit = child.exitCode.pipe(
      Effect.mapError((cause) => connectionError("Cursor sign in stopped unexpectedly.", cause)),
      Effect.flatMap((code) =>
        Number(code) === 0
          ? Effect.void
          : Effect.fail(connectionError("Cursor sign in was not completed.")),
      ),
      Effect.timeoutOption(AUTH_LOGIN_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            cancel.pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.fail(connectionError("Cursor sign in took too long. Start sign in again.")),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

    return { authorizationUrl: url, waitForExit, cancel };
  });

  const logout = runCursorLifecycleCommand(settings, accountEnvironment, spawner, ["logout"]).pipe(
    Effect.mapError((cause) => connectionError("Cursor could not sign out.", cause)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(connectionError("Cursor sign out timed out.")),
        onSome: (result) =>
          result.code === 0
            ? Effect.void
            : Effect.fail(connectionError("Cursor could not sign out.")),
      }),
    ),
    Effect.andThen(
      verifyAbout.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(connectionError("Cursor sign-out verification timed out.")),
            onSome: (result) => {
              const parsed = parseCursorAboutOutput(result);
              return parsed.auth.status === "unauthenticated"
                ? Effect.void
                : Effect.fail(connectionError("Cursor still reports a connected account."));
            },
          }),
        ),
      ),
    ),
  );

  return Effect.succeed(
    makeCursorConnectionActionsFromRuntime({ startLogin, verifyLoggedIn, logout }),
  );
});

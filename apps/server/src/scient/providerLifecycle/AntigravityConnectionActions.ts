/**
 * Official Google-account lifecycle for Antigravity.
 *
 * The Antigravity CLI owns OAuth credentials and subscription entitlement.
 * Scient launches its interactive login in a real PTY, lets the CLI open the
 * Google page, and verifies completion through the provider-owned `agy models`
 * command. Sign-out is first requested through Antigravity's `/logout`
 * command. Some CLI versions block that command behind first-run screens even
 * when a consumer session already exists; in that case Scient removes only
 * Antigravity's own local consumer credential entries and verifies the result
 * through `agy models`. Scient never reads token contents.
 */

import type {
  AntigravitySettings,
  ProviderAuthorizationUrlKind,
  ProviderConnectionMethod,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type {
  ProviderConnectionActions,
  ProviderConnectionActionFailure,
} from "../../provider/ProviderDriver.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import type * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import {
  findTerminalAuthorizationUrl,
  normalizeTerminalOutput,
  pickProcessEnvironment,
  ProviderConnectionActionError,
  withProviderSessionShutdown,
} from "./ProviderConnectionActions.ts";

const AUTH_LOGIN_TIMEOUT = "10 minutes";
const AUTH_VERIFY_TIMEOUT = "15 seconds";
const AUTH_VERIFY_POLL = "1 second";
const AUTH_URL_GRACE = "3 seconds";
// OAuth URLs are long enough to wrap in an ordinary terminal. This PTY is
// hidden, so give the provider enough width to emit one complete, copyable URL.
const AUTH_TERMINAL_COLUMNS = 2_000;
const AUTHORIZATION_CODE_MAX_LENGTH = 8_192;
const LOGOUT_TIMEOUT = "15 seconds";
const LOCAL_LOGOUT_VERIFY_TIMEOUT = "5 seconds";
const MAX_AUTH_OUTPUT_BYTES = 128 * 1024;
const AUTH_FALLBACK_URL = "https://antigravity.google/docs/cli/install/#authentication-workflows";
const ANSI_ESCAPE_CHARACTER = String.fromCharCode(27);
const ANTIGRAVITY_ONBOARDING_PROMPT =
  /Choose your color scheme:|Terms of Service & Data Use|Select login method:/u;
const ANTIGRAVITY_WORKSPACE_TRUST_PROMPT = /Do you trust the contents of this project\?/u;
const ANTIGRAVITY_GOOGLE_LOGIN_PROMPT = /Select login method:[\s\S]*1\. Google OAuth/u;
const TERMINAL_MODE_QUERIES = [
  {
    query: `${ANSI_ESCAPE_CHARACTER}[?2026$p`,
    response: `${ANSI_ESCAPE_CHARACTER}[?2026;2$y`,
  },
  {
    query: `${ANSI_ESCAPE_CHARACTER}[?2027$p`,
    response: `${ANSI_ESCAPE_CHARACTER}[?2027;2$y`,
  },
] as const;

type LegacyAntigravityConnectionSettings = Pick<
  AntigravitySettings,
  "enabled" | "binaryPath" | "customModels"
>;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

const connectionError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export function officialAntigravityAccountEnvironment(
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
    "BROWSER",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
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
  // Scient owns updates for its reviewed app-private runtime. Google documents
  // this exact variable for disabling Antigravity's in-place auto-updater.
  result.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return result;
}

function isAntigravityAuthorizationHost(hostname: string): boolean {
  return (
    hostname === "accounts.google.com" ||
    hostname === "antigravity.google" ||
    hostname.endsWith(".antigravity.google")
  );
}

export function findAntigravityAuthorizationUrl(output: string): string | undefined {
  return findTerminalAuthorizationUrl(output, (url) =>
    isAntigravityAuthorizationHost(url.hostname),
  );
}

function normalizeAntigravityTerminalOutput(output: string): string {
  return normalizeTerminalOutput(output);
}

export function antigravityTerminalResponses(output: string): ReadonlyArray<string> {
  return TERMINAL_MODE_QUERIES.filter(({ query }) => output.includes(query)).map(
    ({ response }) => response,
  );
}

export function isAntigravityModelsAuthenticated(input: {
  readonly code: number;
  readonly stdout: string;
}): boolean {
  return input.code === 0 && input.stdout.trim().length > 0;
}

export interface AntigravityLoginProcess {
  readonly authorizationUrl: string;
  readonly authorizationUrlKind: ProviderAuthorizationUrlKind;
  readonly submitAuthorizationCode?:
    | ((code: string) => Effect.Effect<void, ProviderConnectionActionFailure>)
    | undefined;
  readonly waitForExit: Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly cancel: Effect.Effect<void, ProviderConnectionActionFailure>;
}

export interface AntigravityAuthRuntime {
  readonly startLogin: Effect.Effect<
    AntigravityLoginProcess,
    ProviderConnectionActionFailure,
    Scope.Scope
  >;
  readonly verifyLoggedIn: Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly logout: Effect.Effect<void, ProviderConnectionActionFailure, Scope.Scope>;
}

export interface AntigravityLocalCredentialStore {
  readonly removeConsumerCredential: Effect.Effect<
    void,
    ProviderConnectionActionFailure,
    Scope.Scope
  >;
}

export function makeAntigravityLocalCredentialStore(
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  platform: NodeJS.Platform,
): AntigravityLocalCredentialStore {
  const isWindows =
    environment.SystemRoot !== undefined ||
    environment.SYSTEMROOT !== undefined ||
    environment.ComSpec !== undefined ||
    environment.COMSPEC !== undefined;
  const homeDirectory = isWindows
    ? (environment.USERPROFILE ?? environment.HOME)
    : (environment.HOME ?? environment.USERPROFILE);

  const removeConsumerCredential = Effect.gen(function* () {
    if (!homeDirectory) {
      return yield* connectionError(
        "Scient could not locate Antigravity's saved session on this computer.",
      );
    }

    yield* fileSystem
      .remove(path.join(homeDirectory, ".gemini", "antigravity-cli", "antigravity-oauth-token"), {
        force: true,
      })
      .pipe(
        Effect.mapError((cause) =>
          connectionError(
            "Scient could not remove Antigravity's saved session from this computer.",
            cause,
          ),
        ),
      );

    if (platform !== "darwin") return;

    const child = yield* spawner
      .spawn(
        ChildProcess.make("/usr/bin/security", ["delete-generic-password", "-s", "gemini"], {
          env: environment,
          extendEnv: false,
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          connectionError("Scient could not update Antigravity's macOS Keychain entry.", cause),
        ),
      );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        collectUint8StreamText({
          stream: child.stdout,
          maxBytes: MAX_AUTH_OUTPUT_BYTES,
          truncatedMarker: "\n[output truncated]",
        }).pipe(Effect.map((result) => result.text)),
        collectUint8StreamText({
          stream: child.stderr,
          maxBytes: MAX_AUTH_OUTPUT_BYTES,
          truncatedMarker: "\n[output truncated]",
        }).pipe(Effect.map((result) => result.text)),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) =>
        connectionError("Scient could not inspect Antigravity's macOS Keychain result.", cause),
      ),
    );
    const notFound = /specified item could not be found in the keychain/iu.test(
      `${stdout}\n${stderr}`,
    );
    if (code !== 0 && code !== 44 && !notFound) {
      return yield* connectionError(
        "Scient could not remove Antigravity's saved session from the macOS Keychain.",
      );
    }
  });

  return { removeConsumerCredential };
}

export function makeAntigravityConnectionActionsFromRuntime(
  runtime: AntigravityAuthRuntime,
): ProviderConnectionActions {
  return {
    methods: ["antigravity_google"],
    start: (method: ProviderConnectionMethod) =>
      Effect.gen(function* () {
        if (method !== "antigravity_google") {
          return yield* connectionError("Antigravity does not support this sign-in method.");
        }
        const process = yield* runtime.startLogin;
        return {
          authorizationUrl: process.authorizationUrl,
          authorizationUrlKind: process.authorizationUrlKind,
          initialStatus: "waiting_for_browser",
          ...(process.submitAuthorizationCode
            ? { submitAuthorizationCode: process.submitAuthorizationCode }
            : {}),
          waitForCompletion: process.waitForExit.pipe(Effect.andThen(runtime.verifyLoggedIn)),
          cancel: process.cancel,
        };
      }),
    disconnect: runtime.logout,
  };
}

export function withAntigravitySessionShutdown<E>(
  actions: ProviderConnectionActions,
  stopAll: Effect.Effect<void, E>,
): ProviderConnectionActions {
  return withProviderSessionShutdown(
    actions,
    stopAll,
    (cause) =>
      new ProviderConnectionActionError({
        message: "Scient could not stop active Antigravity sessions before sign out.",
        cause,
      }),
  );
}

const runAgyModels = Effect.fn("AntigravityConnectionActions.runModels")(function* (
  settings: LegacyAntigravityConnectionSettings,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const resolved = yield* resolveSpawnCommand(settings.binaryPath || "agy", ["models"], {
    env: environment,
    extendEnv: false,
  });
  const child = yield* spawner.spawn(
    ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      extendEnv: false,
      shell: resolved.shell,
      stdin: "ignore",
    }),
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [
      collectUint8StreamText({
        stream: child.stdout,
        maxBytes: MAX_AUTH_OUTPUT_BYTES,
        truncatedMarker: "\n[output truncated]",
      }).pipe(Effect.map((result) => result.text)),
      collectUint8StreamText({
        stream: child.stderr,
        maxBytes: MAX_AUTH_OUTPUT_BYTES,
        truncatedMarker: "\n[output truncated]",
      }).pipe(Effect.map((result) => result.text)),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, code };
});

function ptySpawnCommand(
  resolved: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly shell: boolean;
  },
  environment: NodeJS.ProcessEnv,
): { readonly shell: string; readonly args: ReadonlyArray<string> } {
  if (!resolved.shell) return { shell: resolved.command, args: resolved.args };
  return {
    shell: environment.COMSPEC ?? environment.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [resolved.command, ...resolved.args].join(" ")],
  };
}

export const makeAntigravityConnectionActions = Effect.fn("AntigravityConnectionActions.make")(
  function (
    settings: LegacyAntigravityConnectionSettings,
    environment: NodeJS.ProcessEnv,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    ptyAdapter: PtyAdapter.PtyAdapter["Service"],
    localCredentialStore: AntigravityLocalCredentialStore,
  ): Effect.Effect<ProviderConnectionActions> {
    const agyEnvironment = officialAntigravityAccountEnvironment(environment);

    const isLoggedIn = runAgyModels(settings, agyEnvironment, spawner).pipe(
      Effect.scoped,
      Effect.timeoutOption(AUTH_VERIFY_TIMEOUT),
      Effect.map(
        Option.match({
          onNone: () => false,
          onSome: isAntigravityModelsAuthenticated,
        }),
      ),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    const verifyLoggedIn = isLoggedIn.pipe(
      Effect.flatMap((authenticated) =>
        authenticated
          ? Effect.void
          : Effect.fail(
              connectionError(
                "Antigravity did not report an authenticated Google account with model access.",
              ),
            ),
      ),
    );

    const spawnInteractive = (args: ReadonlyArray<string> = []) =>
      Effect.gen(function* () {
        const resolved = yield* resolveSpawnCommand(settings.binaryPath || "agy", args, {
          env: agyEnvironment,
          extendEnv: false,
        }).pipe(
          Effect.mapError((cause) =>
            connectionError("Scient could not prepare Antigravity sign in.", cause),
          ),
        );
        const ptyCommand = ptySpawnCommand(resolved, agyEnvironment);
        return yield* ptyAdapter
          .spawn({
            shell: ptyCommand.shell,
            args: [...ptyCommand.args],
            cwd: agyEnvironment.HOME ?? agyEnvironment.USERPROFILE ?? NodeOS.homedir(),
            cols: AUTH_TERMINAL_COLUMNS,
            rows: 30,
            env: agyEnvironment,
          })
          .pipe(
            Effect.mapError((cause) =>
              connectionError("Scient could not start the Antigravity sign-in terminal.", cause),
            ),
          );
      });

    const startLogin = Effect.gen(function* () {
      if (yield* isLoggedIn) {
        return {
          authorizationUrl: AUTH_FALLBACK_URL,
          authorizationUrlKind: "manual_fallback",
          waitForExit: Effect.void,
          cancel: Effect.void,
        } satisfies AntigravityLoginProcess;
      }

      const process = yield* spawnInteractive();
      let output = "";
      let authorizationUrl: string | undefined;
      let exited = false;
      let selectedGoogleLogin = false;
      let terminalWriteFailure: unknown;
      const sentTerminalResponses = new Set<string>();
      const removeDataListener = process.onData((data) => {
        output = `${output}${data}`.slice(-MAX_AUTH_OUTPUT_BYTES);
        authorizationUrl ??= findAntigravityAuthorizationUrl(output);
        try {
          // Inspect the retained output, not only this callback's chunk: a PTY
          // may split a terminal capability query across data events.
          for (const response of antigravityTerminalResponses(output)) {
            if (sentTerminalResponses.has(response)) continue;
            sentTerminalResponses.add(response);
            process.write(response);
          }
          if (
            !selectedGoogleLogin &&
            ANTIGRAVITY_GOOGLE_LOGIN_PROMPT.test(normalizeAntigravityTerminalOutput(output))
          ) {
            selectedGoogleLogin = true;
            // The user explicitly chose Google sign-in in Scient. Select the
            // provider's default Google OAuth option; legal/telemetry onboarding
            // remains provider-owned and is never accepted by Scient.
            process.write("\r");
          }
        } catch (cause) {
          terminalWriteFailure ??= cause;
        }
      });
      const removeExitListener = process.onExit(() => {
        exited = true;
      });
      yield* Effect.addFinalizer(() =>
        Effect.try({
          try: () => {
            removeDataListener();
            removeExitListener();
            if (!exited) process.kill();
          },
          catch: () => undefined,
        }).pipe(Effect.ignore),
      );

      const cancel = Effect.try({
        try: () => {
          if (!exited) process.kill();
        },
        catch: (cause) => connectionError("Antigravity sign in could not be cancelled.", cause),
      });

      const submitAuthorizationCode = (code: string) => {
        const normalized = code.trim();
        if (
          normalized.length === 0 ||
          normalized.length > AUTHORIZATION_CODE_MAX_LENGTH ||
          hasControlCharacter(normalized)
        ) {
          return Effect.fail(
            connectionError("Enter the one-time authorization code shown by Google."),
          );
        }
        return Effect.try({
          try: () => process.write(`${normalized}\r`),
          catch: (cause) =>
            connectionError(
              "Scient could not return the one-time authorization code to Antigravity.",
              cause,
            ),
        });
      };

      const deadline = Duration.toMillis(AUTH_URL_GRACE);
      const startedAt = yield* Clock.currentTimeMillis;
      while (true) {
        if (terminalWriteFailure !== undefined) {
          return yield* connectionError(
            "Antigravity could not receive the Google sign-in selection.",
            terminalWriteFailure,
          );
        }
        if (
          authorizationUrl ||
          exited ||
          (yield* Clock.currentTimeMillis) - startedAt >= deadline
        ) {
          break;
        }
        yield* Effect.sleep("100 millis");
      }

      const waitForExit = Effect.gen(function* () {
        const timeout = Duration.toMillis(AUTH_LOGIN_TIMEOUT);
        const loginStartedAt = yield* Clock.currentTimeMillis;
        while ((yield* Clock.currentTimeMillis) - loginStartedAt < timeout) {
          if (yield* isLoggedIn) {
            yield* cancel.pipe(Effect.ignore);
            return;
          }
          if (exited) {
            return yield* connectionError(
              "Antigravity sign in ended before Google authentication completed.",
            );
          }
          yield* Effect.sleep(AUTH_VERIFY_POLL);
        }
        yield* cancel.pipe(Effect.ignore);
        return yield* connectionError("Antigravity sign in took too long. Start sign in again.");
      });

      return {
        authorizationUrl: authorizationUrl ?? AUTH_FALLBACK_URL,
        authorizationUrlKind: authorizationUrl ? "primary" : "manual_fallback",
        submitAuthorizationCode,
        waitForExit,
        cancel,
      } satisfies AntigravityLoginProcess;
    });

    const logout = Effect.gen(function* () {
      if (!(yield* isLoggedIn)) return;

      // `--prompt-interactive /logout` queues the provider's documented slash
      // command itself. This avoids guessing when the Bubble Tea prompt is ready
      // and keeps the normal sign-out path entirely inside Antigravity.
      const process = yield* spawnInteractive(["--prompt-interactive", "/logout"]).pipe(
        Effect.mapError((cause) => connectionError("Antigravity could not start sign out.", cause)),
      );
      let exited = false;
      let output = "";
      let terminalWriteFailure: unknown;
      const sentTerminalResponses = new Set<string>();
      const removeDataListener = process.onData((data) => {
        output = `${output}${data}`.slice(-MAX_AUTH_OUTPUT_BYTES);
        try {
          for (const response of antigravityTerminalResponses(output)) {
            if (sentTerminalResponses.has(response)) continue;
            sentTerminalResponses.add(response);
            process.write(response);
          }
        } catch (cause) {
          terminalWriteFailure ??= cause;
        }
      });
      const removeExitListener = process.onExit(() => {
        exited = true;
      });
      yield* Effect.addFinalizer(() =>
        Effect.try({
          try: () => {
            removeDataListener();
            removeExitListener();
            if (!exited) process.kill();
          },
          catch: () => undefined,
        }).pipe(Effect.ignore),
      );

      const stop = Effect.try({
        try: () => {
          if (!exited) process.kill();
        },
        catch: (cause) => connectionError("Antigravity sign out could not stop cleanly.", cause),
      });

      const removeLocalConsumerCredential = Effect.gen(function* () {
        yield* stop.pipe(Effect.ignore);
        yield* localCredentialStore.removeConsumerCredential;

        const timeout = Duration.toMillis(LOCAL_LOGOUT_VERIFY_TIMEOUT);
        const startedAt = yield* Clock.currentTimeMillis;
        while ((yield* Clock.currentTimeMillis) - startedAt < timeout) {
          if (!(yield* isLoggedIn)) return;
          yield* Effect.sleep(AUTH_VERIFY_POLL);
        }
        return yield* connectionError("Antigravity still reports a connected Google account.");
      });

      const timeout = Duration.toMillis(LOGOUT_TIMEOUT);
      const startedAt = yield* Clock.currentTimeMillis;
      while ((yield* Clock.currentTimeMillis) - startedAt < timeout) {
        if (!(yield* isLoggedIn)) {
          yield* stop.pipe(Effect.ignore);
          return;
        }
        if (terminalWriteFailure !== undefined) {
          return yield* removeLocalConsumerCredential;
        }
        const normalizedOutput = normalizeAntigravityTerminalOutput(output);
        if (
          ANTIGRAVITY_ONBOARDING_PROMPT.test(normalizedOutput) ||
          ANTIGRAVITY_WORKSPACE_TRUST_PROMPT.test(normalizedOutput)
        ) {
          return yield* removeLocalConsumerCredential;
        }
        if (exited) return yield* removeLocalConsumerCredential;
        yield* Effect.sleep(AUTH_VERIFY_POLL);
      }
      return yield* removeLocalConsumerCredential;
    });

    return Effect.succeed(
      makeAntigravityConnectionActionsFromRuntime({
        startLogin,
        verifyLoggedIn,
        logout,
      }),
    );
  },
);

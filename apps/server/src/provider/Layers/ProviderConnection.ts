/**
 * ProviderConnectionLive - supervised, provider-owned browser authentication.
 *
 * The operation is intentionally transient: no credentials or raw CLI output
 * are logged, persisted, or sent to the renderer.
 *
 * @module ProviderConnectionLive
 */
import { randomUUID } from "node:crypto";

import type {
  ProviderKind,
  ServerProviderConnectionMethod,
  ServerProviderConnectionState,
  ServerProviderStatus,
} from "@synara/contracts";
import { ServerProviderConnectionError } from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import {
  Duration,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config";
import { buildCodexProcessEnv } from "../../codexProcessEnv";
import { resolveBaseCodexHomePath } from "../../codexHomePaths";
import { ServerSettingsService } from "../../serverSettings";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText";
import { PtyAdapter } from "../../terminal/Services/PTY";
import { buildClaudeProcessEnv } from "../claudeProcessEnv";
import { buildCursorAgentCommand } from "../acp/CursorAcpCommand";
import { probeDroidAcpAuthentication } from "../acp/DroidAcpSupport";
import { ProviderConnection, type ProviderConnectionShape } from "../Services/ProviderConnection";
import { ProviderDiscoveryService } from "../Services/ProviderDiscoveryService";
import { ProviderHealth } from "../Services/ProviderHealth";
import { ProviderRuntimeManager } from "../Services/ProviderRuntimeManager";
import { parseAntigravityModelsAuthStatus } from "./ProviderHealth";

const CONNECTION_TIMEOUT = Duration.minutes(10);
// Antigravity keeps the provider-owned code window at 60 seconds. The local
// supervisor gets a small hidden grace period so a CLI exit at that boundary
// can still complete one bounded authentication probe.
const ANTIGRAVITY_CONNECTION_TIMEOUT = Duration.seconds(65);
const CONNECTION_OUTPUT_MAX_BYTES = 64 * 1024;

interface ActiveConnection {
  readonly operationId: string;
  readonly fiber: Fiber.Fiber<void, never>;
  readonly authorizationCodeInput: Deferred.Deferred<string>;
  readonly authorizationCodeAccepted: Deferred.Deferred<void>;
  readonly authorizationCodeClosed: Deferred.Deferred<void>;
}

interface ConnectionCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly waitingMessage: string;
  readonly strategy?: "antigravity-browser";
}

interface ConnectionOutputObserver {
  readonly onOutputChunk?: (chunk: Uint8Array) => Effect.Effect<void> | undefined;
}

const GROK_OAUTH_AUTHORIZATION_ORIGIN = "https://auth.x.ai";
const GROK_OAUTH_AUTHORIZATION_PATH = "/oauth2/authorize";
const GOOGLE_OAUTH_AUTHORIZATION_ORIGIN = "https://accounts.google.com";
const GOOGLE_OAUTH_AUTHORIZATION_PATHS = new Set(["/o/oauth2/auth", "/o/oauth2/v2/auth"]);
const ANTIGRAVITY_OAUTH_CALLBACK_ORIGIN = "https://antigravity.google";
const ANTIGRAVITY_OAUTH_CALLBACK_PATH = "/oauth-callback";
const OAUTH_OUTPUT_BUFFER_MAX_CHARS = 16 * 1024;
const ANTIGRAVITY_AUTH_PROMPT =
  "Authenticate this Antigravity CLI only. Do not inspect or modify files and do not perform a task.";
const authorizationCodeEncoder = new TextEncoder();

function outputUrlCandidates(output: string): ReadonlyArray<string> {
  return (output.match(/https:\/\/[^\s<>"']+/gu) ?? []).filter(
    (candidate) =>
      !Array.from(candidate).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
      }),
  );
}

export function parseGrokOAuthAuthorizationUrl(output: string): string | null {
  for (const candidate of outputUrlCandidates(output)) {
    if (candidate.length > 8_192) continue;
    try {
      const url = new URL(candidate);
      if (
        url.origin !== GROK_OAUTH_AUTHORIZATION_ORIGIN ||
        url.pathname !== GROK_OAUTH_AUTHORIZATION_PATH ||
        url.hash ||
        url.username ||
        url.password ||
        url.searchParams.get("response_type") !== "code" ||
        !url.searchParams.get("state") ||
        !url.searchParams.get("code_challenge")
      ) {
        continue;
      }
      const redirectValue = url.searchParams.get("redirect_uri");
      if (!redirectValue) continue;
      const redirectUrl = new URL(redirectValue);
      if (
        redirectUrl.protocol !== "http:" ||
        redirectUrl.hostname !== "127.0.0.1" ||
        !redirectUrl.port ||
        redirectUrl.pathname !== "/callback" ||
        redirectUrl.search ||
        redirectUrl.hash ||
        redirectUrl.username ||
        redirectUrl.password
      ) {
        continue;
      }
      return url.toString();
    } catch {
      // Ignore malformed or incomplete output while the CLI is still streaming.
    }
  }
  return null;
}

export function parseAntigravityOAuthAuthorizationUrl(output: string): string | null {
  for (const candidate of outputUrlCandidates(output)) {
    if (candidate.length > 8_192) continue;
    try {
      const url = new URL(candidate);
      if (
        url.origin !== GOOGLE_OAUTH_AUTHORIZATION_ORIGIN ||
        !GOOGLE_OAUTH_AUTHORIZATION_PATHS.has(url.pathname) ||
        url.hash ||
        url.username ||
        url.password ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !url.searchParams.get("client_id") ||
        !url.searchParams.get("state") ||
        !url.searchParams.get("code_challenge")
      ) {
        continue;
      }
      const redirectValue = url.searchParams.get("redirect_uri");
      if (!redirectValue) continue;
      const redirectUrl = new URL(redirectValue);
      if (
        redirectUrl.origin !== ANTIGRAVITY_OAUTH_CALLBACK_ORIGIN ||
        redirectUrl.pathname !== ANTIGRAVITY_OAUTH_CALLBACK_PATH ||
        redirectUrl.search ||
        redirectUrl.hash ||
        redirectUrl.username ||
        redirectUrl.password
      ) {
        continue;
      }
      return url.toString();
    } catch {
      // Ignore malformed or incomplete output while the CLI is still streaming.
    }
  }
  return null;
}

/**
 * Antigravity 1.1.4 has no login subcommand, and its hidden bare TUI does not
 * advance to authentication. Print mode reaches provider-owned OAuth before
 * model selection. A per-operation impossible model plus sandboxed plan mode
 * prevents a real turn; the models health probe stops the process after auth.
 */
export function antigravityAuthenticationCommandArgs(operationId: string): ReadonlyArray<string> {
  return [
    "--sandbox",
    "--mode",
    "plan",
    "--model",
    `__scient_auth_only_${operationId}`,
    "--print-timeout",
    "60s",
    "--print",
    ANTIGRAVITY_AUTH_PROMPT,
  ];
}

export function expectedMethodForProvider(
  provider: ProviderKind,
): ServerProviderConnectionMethod | null {
  switch (provider) {
    case "codex":
      return "codex_browser";
    case "claudeAgent":
      return "claude_account";
    case "cursor":
      return "cursor_browser";
    case "antigravity":
      return "antigravity_browser";
    case "grok":
      return "grok_browser";
    case "droid":
      return "droid_device_pairing";
    default:
      return null;
  }
}

export function providerConnectionCommandArgs(
  provider: ProviderKind,
  method: ServerProviderConnectionMethod,
): ReadonlyArray<string> | null {
  if (provider === "codex" && method === "codex_browser") return ["login"];
  if (provider === "claudeAgent" && method === "claude_account") {
    return ["auth", "login"];
  }
  if (provider === "claudeAgent" && method === "claude_sso") {
    return ["auth", "login", "--sso"];
  }
  if (provider === "claudeAgent" && method === "claude_console") {
    return ["auth", "login", "--console"];
  }
  if (provider === "cursor" && method === "cursor_browser") return ["login"];
  if (provider === "antigravity" && method === "antigravity_browser") return [];
  if (provider === "grok" && method === "grok_browser") return ["login", "--oauth"];
  if (provider === "droid" && method === "droid_device_pairing") {
    return ["exec", "--output-format", "acp"];
  }
  return null;
}

function makeConnectionError(input: {
  readonly provider: ProviderKind;
  readonly reason: ConstructorParameters<typeof ServerProviderConnectionError>[0]["reason"];
  readonly message: string;
}) {
  return new ServerProviderConnectionError(input);
}

export function makeProviderConnectionLive(options?: {
  readonly timeout?: Duration.Duration;
  readonly antigravityTimeout?: Duration.Duration;
  readonly droidAuthenticationProbe?: typeof probeDroidAcpAuthentication;
}) {
  const timeout = options?.timeout ?? CONNECTION_TIMEOUT;
  const antigravityTimeout = options?.antigravityTimeout ?? ANTIGRAVITY_CONNECTION_TIMEOUT;

  return Layer.effect(
    ProviderConnection,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const providerHealth = yield* ProviderHealth;
      const providerDiscovery = yield* ProviderDiscoveryService;
      const providerRuntimeManager = yield* ProviderRuntimeManager;
      const ptyAdapter = yield* PtyAdapter;
      const operationScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(operationScope, Exit.void));
      const activeConnectionsRef = yield* Ref.make<ReadonlyMap<ProviderKind, ActiveConnection>>(
        new Map(),
      );
      const reservedProvidersRef = yield* Ref.make<ReadonlySet<ProviderKind>>(new Set());

      const publishState = (provider: ProviderKind, state: ServerProviderConnectionState) =>
        providerHealth.setConnectionState(provider, state);

      const reserveProvider = (provider: ProviderKind) =>
        Ref.modify(reservedProvidersRef, (reserved) => {
          if (reserved.has(provider)) return [false, reserved] as const;
          const next = new Set(reserved);
          next.add(provider);
          return [true, next] as const;
        });

      const releaseProvider = (provider: ProviderKind, operationId: string) =>
        Effect.all(
          [
            Ref.update(activeConnectionsRef, (active) => {
              if (active.get(provider)?.operationId !== operationId) return active;
              const next = new Map(active);
              next.delete(provider);
              return next;
            }),
            Ref.update(reservedProvidersRef, (reserved) => {
              const next = new Set(reserved);
              next.delete(provider);
              return next;
            }),
          ],
          { discard: true },
        );

      const resolveCommand = Effect.fn("ProviderConnection.resolveCommand")(function* (
        provider: ProviderKind,
        method: ServerProviderConnectionMethod,
      ) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(() =>
            makeConnectionError({
              provider,
              reason: "provider_disabled",
              message: "Scient could not read the provider settings.",
            }),
          ),
        );
        const expectedMethod = expectedMethodForProvider(provider);
        if (!expectedMethod) {
          return yield* makeConnectionError({
            provider,
            reason: "unsupported_provider",
            message: "This provider does not yet support in-app sign in.",
          });
        }
        const args = providerConnectionCommandArgs(provider, method);
        if (!args) {
          return yield* makeConnectionError({
            provider,
            reason: "invalid_method",
            message: "The selected sign-in method is not valid for this provider.",
          });
        }

        const resolveRuntime = (configured: string | undefined) =>
          providerRuntimeManager.resolve(provider, configured).pipe(
            Effect.flatMap((runtime) =>
              runtime.source === "missing" || runtime.source === "bundled" || !runtime.executable
                ? Effect.fail(
                    makeConnectionError({
                      provider,
                      reason: "provider_not_installed",
                      message: "Install the provider before signing in.",
                    }),
                  )
                : Effect.succeed(runtime),
            ),
          );
        const resolveExecutable = (configured: string | undefined, fallback: string) =>
          resolveRuntime(configured).pipe(Effect.map((runtime) => runtime.executable ?? fallback));

        if (provider === "codex") {
          if (!settings.providers.codex.enabled) {
            return yield* makeConnectionError({
              provider,
              reason: "provider_disabled",
              message: "Codex is disabled in Scient settings.",
            });
          }
          const homePath = settings.providers.codex.homePath.trim() || undefined;
          const runtimeEnv = yield* Effect.promise(() =>
            buildCodexProcessEnv(homePath ? { homePath } : {}),
          );
          const executable = yield* resolveExecutable(
            settings.providers.codex.binaryPath.trim() || undefined,
            "codex",
          );
          return {
            executable,
            args,
            env: {
              ...runtimeEnv,
              CODEX_HOME: resolveBaseCodexHomePath(process.env, homePath),
            },
            waitingMessage: "Finish signing in to ChatGPT in the browser window.",
          } satisfies ConnectionCommand;
        }

        if (provider === "cursor") {
          if (!settings.providers.cursor.enabled) {
            return yield* makeConnectionError({
              provider,
              reason: "provider_disabled",
              message: "Cursor is disabled in Scient settings.",
            });
          }
          const cursorExecutable = yield* resolveExecutable(
            settings.providers.cursor.binaryPath.trim() || undefined,
            "cursor-agent",
          );
          const cursorCommand = buildCursorAgentCommand(cursorExecutable, args);
          return {
            executable: cursorCommand.command,
            args: cursorCommand.args,
            env: process.env,
            waitingMessage: "Finish signing in to Cursor in the browser window.",
          } satisfies ConnectionCommand;
        }

        if (provider === "antigravity") {
          if (!settings.providers.antigravity.enabled) {
            return yield* makeConnectionError({
              provider,
              reason: "provider_disabled",
              message: "Antigravity is disabled in Scient settings.",
            });
          }
          const runtime = yield* resolveRuntime(
            settings.providers.antigravity.binaryPath.trim() || undefined,
          );
          return {
            executable: runtime.executable ?? "agy",
            args,
            env:
              runtime.source === "managed"
                ? { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }
                : process.env,
            cwd: serverConfig.stateDir,
            waitingMessage: "Finish signing in to Google, then paste the code here.",
            strategy: "antigravity-browser",
          } satisfies ConnectionCommand;
        }

        if (provider === "grok") {
          if (!settings.providers.grok.enabled) {
            return yield* makeConnectionError({
              provider,
              reason: "provider_disabled",
              message: "Grok is disabled in Scient settings.",
            });
          }
          const runtime = yield* resolveRuntime(
            settings.providers.grok.binaryPath.trim() || undefined,
          );
          return {
            executable: runtime.executable ?? "grok",
            args: runtime.source === "managed" ? ["--no-auto-update", ...args] : args,
            env: process.env,
            waitingMessage:
              "Finish authorizing Grok in the xAI browser window. No terminal code is required.",
          } satisfies ConnectionCommand;
        }

        if (provider === "droid") {
          if (!settings.providers.droid.enabled) {
            return yield* makeConnectionError({
              provider,
              reason: "provider_disabled",
              message: "Droid is disabled in Scient settings.",
            });
          }
          return {
            executable: yield* resolveExecutable(
              settings.providers.droid.binaryPath.trim() || undefined,
              "droid",
            ),
            args,
            env: process.env,
            waitingMessage: "Finish confirming the Factory device code in your browser.",
          } satisfies ConnectionCommand;
        }

        if (!settings.providers.claudeAgent.enabled) {
          return yield* makeConnectionError({
            provider,
            reason: "provider_disabled",
            message: "Claude is disabled in Scient settings.",
          });
        }
        const runtime = yield* resolveRuntime(
          settings.providers.claudeAgent.binaryPath.trim() || undefined,
        );
        const executable = runtime.executable ?? "claude";
        return {
          executable,
          args,
          env: {
            ...buildClaudeProcessEnv({ homeDir: serverConfig.homeDir }),
            ...(runtime.source === "managed" ? { DISABLE_AUTOUPDATER: "1" } : {}),
          },
          waitingMessage:
            method === "claude_sso"
              ? "Finish signing in with your Claude organization in the browser window."
              : method === "claude_console"
                ? "Finish signing in to Anthropic Console in the browser window."
                : "Finish signing in to your Claude account in the browser window.",
        } satisfies ConnectionCommand;
      });

      const runCommandResult = Effect.fn("ProviderConnection.runCommandResult")(function* (
        command: ConnectionCommand,
        observer?: ConnectionOutputObserver,
      ) {
        const prepared = prepareWindowsSafeProcess(command.executable, command.args, {
          env: command.env,
          ...(command.cwd ? { cwd: command.cwd } : {}),
        });
        const child = yield* spawner.spawn(
          ChildProcess.make(prepared.command, prepared.args, {
            shell: prepared.shell,
            ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            env: command.env,
            ...(command.cwd ? { cwd: command.cwd } : {}),
            stdin: "ignore",
          }),
        );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
        const observe = (stream: Stream.Stream<Uint8Array, unknown>) =>
          observer?.onOutputChunk
            ? stream.pipe(Stream.tap((chunk) => observer.onOutputChunk?.(chunk) ?? Effect.void))
            : stream;
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: observe(child.stdout),
              maxBytes: CONNECTION_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: observe(child.stderr),
              maxBytes: CONNECTION_OUTPUT_MAX_BYTES,
            }),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        return { stdout: stdout.text, stderr: stderr.text, code: exitCode };
      });

      const runCommand = (command: ConnectionCommand, observer?: ConnectionOutputObserver) =>
        runCommandResult(command, observer).pipe(Effect.map((result) => result.code));

      const runAntigravityConnection = (
        command: ConnectionCommand,
        operationId: string,
        authorizationCodeInput: Deferred.Deferred<string>,
        authorizationCodeAccepted: Deferred.Deferred<void>,
        authorizationCodeClosed: Deferred.Deferred<void>,
        onCodeWindowClosed: Effect.Effect<void>,
        observer?: ConnectionOutputObserver,
      ) =>
        Effect.gen(function* () {
          const authenticationProbe = Effect.gen(function* () {
            const probe = yield* runCommandResult({ ...command, args: ["models"] }).pipe(
              Effect.scoped,
              Effect.result,
            );
            return (
              Result.isSuccess(probe) &&
              parseAntigravityModelsAuthStatus(probe.success) === "authenticated"
            );
          });
          const waitForAuthentication = Effect.gen(function* () {
            while (true) {
              if (yield* authenticationProbe) {
                yield* Deferred.succeed(authorizationCodeAccepted, undefined);
                return 0;
              }
              yield* Effect.sleep(Duration.millis(500));
            }
          });
          const prepared = prepareWindowsSafeProcess(
            command.executable,
            antigravityAuthenticationCommandArgs(operationId),
            {
              env: command.env,
              ...(command.cwd ? { cwd: command.cwd } : {}),
            },
          );
          const process = yield* ptyAdapter.spawn({
            shell: prepared.command,
            args: [...prepared.args],
            cwd: command.cwd ?? serverConfig.stateDir,
            cols: 120,
            rows: 40,
            env: command.env,
          });
          const processExit = yield* Deferred.make<number>();
          // The PTY callback performs only bounded synchronous parsing. It
          // enqueues at most one validated publication effect, never raw CLI
          // output, so noisy output cannot accumulate buffers or waiting fibers.
          const outputEffectQueue = yield* Queue.sliding<Effect.Effect<void>>(1);
          yield* Effect.addFinalizer(() => Queue.shutdown(outputEffectQueue).pipe(Effect.asVoid));
          if (observer?.onOutputChunk) {
            yield* Stream.fromQueue(outputEffectQueue).pipe(
              Stream.runForEach((effect) => effect),
              Effect.forkScoped,
            );
          }
          const removeDataListener = process.onData((data) => {
            const publication = observer?.onOutputChunk?.(authorizationCodeEncoder.encode(data));
            if (publication) {
              Effect.runSync(Queue.offer(outputEffectQueue, publication));
            }
          });
          const removeExitListener = process.onExit((event) => {
            Effect.runFork(Deferred.succeed(processExit, event.exitCode).pipe(Effect.asVoid));
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              removeDataListener();
              removeExitListener();
              process.kill();
            }).pipe(Effect.ignore),
          );
          const deliverAuthorizationCode = Deferred.await(authorizationCodeInput).pipe(
            Effect.flatMap((code) =>
              Effect.try({
                try: () => process.write(code),
                catch: (cause) => cause,
              }),
            ),
            Effect.flatMap(() => Effect.never),
          );
          const processCompletion = Effect.raceFirst(
            Deferred.await(processExit),
            deliverAuthorizationCode,
          ).pipe(
            Effect.flatMap((code) =>
              Effect.gen(function* () {
                yield* onCodeWindowClosed;
                if (yield* authenticationProbe) {
                  yield* Deferred.succeed(authorizationCodeAccepted, undefined);
                  return 0;
                }
                return code || 1;
              }),
            ),
          );
          return yield* Effect.raceFirst(waitForAuthentication, processCompletion);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(Deferred.succeed(authorizationCodeClosed, undefined).pipe(Effect.asVoid)),
        );

      const start: ProviderConnectionShape["start"] = Effect.fn("ProviderConnection.start")(
        function* (input) {
          const { provider, method } = input;
          const reserved = yield* reserveProvider(provider);
          if (!reserved) {
            // Starting the same provider is idempotent. Returning the current
            // operation lets a reopened dialog resume or cancel it without
            // spawning a competing credential process.
            return { providers: yield* providerHealth.getStatuses };
          }

          const commandResult = yield* Effect.result(resolveCommand(provider, method));
          if (Result.isFailure(commandResult)) {
            yield* releaseProvider(provider, "");
            return yield* commandResult.failure;
          }
          const command = commandResult.success;
          const refreshedBeforeStart = yield* providerHealth.refresh;
          const currentStatus = refreshedBeforeStart.find((status) => status.provider === provider);
          const requestsCodexReauthentication =
            provider === "codex" && input.mode === "reauthenticate";
          if (requestsCodexReauthentication && currentStatus?.requiresProviderAccount !== true) {
            yield* releaseProvider(provider, "");
            return yield* makeConnectionError({
              provider,
              reason: "invalid_method",
              message:
                "OpenAI account reauthentication is unavailable for this Codex provider configuration.",
            });
          }
          const forceCodexReauthentication = requestsCodexReauthentication;
          if (
            !forceCodexReauthentication &&
            currentStatus?.available &&
            currentStatus.authStatus === "authenticated"
          ) {
            yield* releaseProvider(provider, "");
            return { providers: refreshedBeforeStart };
          }
          const operationId = randomUUID();
          const authorizationCodeInput = yield* Deferred.make<string>();
          const authorizationCodeAccepted = yield* Deferred.make<void>();
          const authorizationCodeClosed = yield* Deferred.make<void>();
          const startedAt = new Date().toISOString();
          const state = (input: {
            readonly status: ServerProviderConnectionState["status"];
            readonly message: string;
            readonly finished?: boolean;
            readonly authorizationUrl?: string;
          }): ServerProviderConnectionState => ({
            operationId,
            method,
            status: input.status,
            startedAt,
            finishedAt: input.finished ? new Date().toISOString() : null,
            message: input.message,
            ...(input.authorizationUrl ? { authorizationUrl: input.authorizationUrl } : {}),
          });

          yield* publishState(
            provider,
            state({ status: "starting", message: "Starting secure browser sign in." }),
          );

          const operation = Effect.gen(function* () {
            yield* publishState(
              provider,
              state({ status: "waiting_for_browser", message: command.waitingMessage }),
            );
            let oauthOutputBuffer = "";
            let publishedAuthorizationUrl: string | null = null;
            const oauthOutputObserver: ConnectionOutputObserver | undefined =
              provider === "grok" || provider === "antigravity"
                ? {
                    onOutputChunk: (chunk) => {
                      if (publishedAuthorizationUrl) return undefined;
                      oauthOutputBuffer =
                        `${oauthOutputBuffer}${Buffer.from(chunk).toString("utf8")}`.slice(
                          -OAUTH_OUTPUT_BUFFER_MAX_CHARS,
                        );
                      const authorizationUrl =
                        provider === "grok"
                          ? parseGrokOAuthAuthorizationUrl(oauthOutputBuffer)
                          : parseAntigravityOAuthAuthorizationUrl(oauthOutputBuffer);
                      if (!authorizationUrl) return undefined;
                      publishedAuthorizationUrl = authorizationUrl;
                      return publishState(
                        provider,
                        state({
                          status: "waiting_for_browser",
                          message: command.waitingMessage,
                          authorizationUrl,
                        }),
                      ).pipe(Effect.asVoid);
                    },
                  }
                : undefined;
            const connectionProcess: Effect.Effect<number, unknown> =
              provider === "droid"
                ? (options?.droidAuthenticationProbe ?? probeDroidAcpAuthentication)({
                    binaryPath: command.executable,
                    childProcessSpawner: spawner,
                    cwd: serverConfig.cwd,
                  }).pipe(Effect.as(0))
                : command.strategy === "antigravity-browser"
                  ? runAntigravityConnection(
                      command,
                      operationId,
                      authorizationCodeInput,
                      authorizationCodeAccepted,
                      authorizationCodeClosed,
                      publishState(
                        provider,
                        state({
                          status: "verifying",
                          message: "Verifying the connection.",
                        }),
                      ).pipe(Effect.asVoid),
                      oauthOutputObserver,
                    )
                  : runCommand(command, oauthOutputObserver).pipe(Effect.scoped);
            const operationTimeout =
              provider === "antigravity" && options?.timeout === undefined
                ? antigravityTimeout
                : timeout;
            const exitCodeResult = yield* connectionProcess.pipe(
              Effect.timeoutOption(operationTimeout),
              Effect.result,
            );

            if (Result.isFailure(exitCodeResult)) {
              yield* publishState(
                provider,
                state({
                  status: "failed",
                  message: "Scient could not start the provider sign-in process.",
                  finished: true,
                }),
              );
              return;
            }
            if (Option.isNone(exitCodeResult.success)) {
              yield* publishState(
                provider,
                state({
                  status: "failed",
                  message: "Sign in timed out. You can try again safely.",
                  finished: true,
                }),
              );
              return;
            }
            if (exitCodeResult.success.value !== 0) {
              yield* publishState(
                provider,
                state({
                  status: "failed",
                  message:
                    provider === "grok"
                      ? "Grok authorization was not completed. Close any old xAI page, update Grok if an update is available, then try again to start a fresh secure browser sign-in."
                      : "Sign in was not completed. No credentials were saved by Scient.",
                  finished: true,
                }),
              );
              return;
            }

            yield* publishState(
              provider,
              state({ status: "verifying", message: "Verifying the connection." }),
            );
            let verified: ServerProviderStatus | undefined;
            for (let attempt = 0; attempt < 10; attempt += 1) {
              const refreshed = yield* providerHealth.refresh;
              verified = refreshed.find((status) => status.provider === provider);
              if (verified?.available && verified.authStatus === "authenticated") break;
              if (attempt < 9) yield* Effect.sleep(Duration.millis(500));
            }
            if (!verified?.available || verified.authStatus !== "authenticated") {
              yield* publishState(
                provider,
                state({
                  status: "failed",
                  message: "Sign in finished, but Scient could not verify the account.",
                  finished: true,
                }),
              );
              return;
            }
            const modelReadiness = yield* providerDiscovery
              .listModels({
                provider,
                binaryPath: command.executable,
                cwd: command.cwd ?? serverConfig.cwd,
              })
              .pipe(Effect.timeoutOption(Duration.seconds(30)), Effect.result);
            if (
              Result.isFailure(modelReadiness) ||
              Option.isNone(modelReadiness.success) ||
              modelReadiness.success.value.models.length === 0
            ) {
              yield* publishState(
                provider,
                state({
                  status: "failed",
                  message:
                    "The account is authenticated, but Scient could not load a usable model catalog.",
                  finished: true,
                }),
              );
              return;
            }
            yield* publishState(
              provider,
              state({
                status: "connected",
                message: "Connected and ready to use.",
                finished: true,
              }),
            );
          }).pipe(
            Effect.onInterrupt(() =>
              publishState(
                provider,
                state({
                  status: "cancelled",
                  message: "Sign in was cancelled.",
                  finished: true,
                }),
              ).pipe(Effect.asVoid),
            ),
            Effect.catch(() =>
              publishState(
                provider,
                state({
                  status: "failed",
                  message: "Sign in stopped unexpectedly. You can try again safely.",
                  finished: true,
                }),
              ).pipe(Effect.asVoid),
            ),
          );

          // The gate prevents a very fast CLI exit from completing and releasing
          // the provider before its cancellable fiber is recorded.
          const startGate = yield* Deferred.make<void>();
          const fiber = yield* Deferred.await(startGate).pipe(
            Effect.andThen(operation),
            // Own the reservation at the outermost fiber boundary. A caller can
            // cancel immediately after start returns, before `operation` begins.
            Effect.ensuring(releaseProvider(provider, operationId)),
            Effect.forkIn(operationScope),
          );
          yield* Ref.update(activeConnectionsRef, (active) => {
            const next = new Map(active);
            next.set(provider, {
              operationId,
              fiber,
              authorizationCodeInput,
              authorizationCodeAccepted,
              authorizationCodeClosed,
            });
            return next;
          });
          yield* Deferred.succeed(startGate, undefined);
          const providers = yield* providerHealth.getStatuses;
          return { providers };
        },
      );

      const cancel: ProviderConnectionShape["cancel"] = Effect.fn("ProviderConnection.cancel")(
        function* (input) {
          const active = (yield* Ref.get(activeConnectionsRef)).get(input.provider);
          if (!active || active.operationId !== input.operationId) {
            return yield* makeConnectionError({
              provider: input.provider,
              reason: "operation_not_found",
              message: "This connection attempt is no longer running.",
            });
          }
          yield* Fiber.interrupt(active.fiber);
          // Restart callers must not race the interrupted operation's process
          // cleanup or reservation finalizer. Do not return until both finish.
          yield* Fiber.await(active.fiber);
          yield* releaseProvider(input.provider, input.operationId);
          const providers = yield* providerHealth.getStatuses;
          return { providers };
        },
      );

      const submitAuthorizationCode: ProviderConnectionShape["submitAuthorizationCode"] = Effect.fn(
        "ProviderConnection.submitAuthorizationCode",
      )(function* (input) {
        if (input.provider !== "antigravity") {
          return yield* makeConnectionError({
            provider: input.provider,
            reason: "authorization_code_not_supported",
            message: "This provider does not accept a pasted authorization code.",
          });
        }
        const active = (yield* Ref.get(activeConnectionsRef)).get(input.provider);
        if (!active || active.operationId !== input.operationId) {
          return yield* makeConnectionError({
            provider: input.provider,
            reason: "operation_not_found",
            message: "This connection attempt is no longer running.",
          });
        }
        if (yield* Deferred.isDone(active.authorizationCodeInput)) {
          return yield* makeConnectionError({
            provider: input.provider,
            reason: "authorization_code_already_submitted",
            message: "A code was already submitted for this connection attempt.",
          });
        }
        if (yield* Deferred.isDone(active.authorizationCodeClosed)) {
          return yield* makeConnectionError({
            provider: input.provider,
            reason: "authorization_code_not_accepted",
            message: "This connection attempt is no longer waiting for a code.",
          });
        }
        const accepted = yield* Deferred.succeed(
          active.authorizationCodeInput,
          `${input.authorizationCode.trim()}\n`,
        );
        if (!accepted) {
          return yield* makeConnectionError({
            provider: input.provider,
            reason: "authorization_code_already_submitted",
            message: "A code was already submitted for this connection attempt.",
          });
        }
        const acceptedByProvider = yield* Effect.raceFirst(
          Deferred.await(active.authorizationCodeAccepted).pipe(Effect.as(true)),
          Deferred.await(active.authorizationCodeClosed).pipe(Effect.as(false)),
        );
        if (!acceptedByProvider) {
          return yield* makeConnectionError({
            provider: input.provider,
            reason: "authorization_code_not_accepted",
            message: "This connection attempt stopped before it could accept the code.",
          });
        }
        return { providers: yield* providerHealth.getStatuses };
      });

      return { start, cancel, submitAuthorizationCode } satisfies ProviderConnectionShape;
    }),
  );
}

export const ProviderConnectionLive = makeProviderConnectionLive();

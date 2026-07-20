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
import { Duration, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Result, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config";
import { buildCodexProcessEnv } from "../../codexProcessEnv";
import { resolveBaseCodexHomePath } from "../../codexHomePaths";
import { ServerSettingsService } from "../../serverSettings";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText";
import { buildClaudeProcessEnv } from "../claudeProcessEnv";
import { buildCursorAgentCommand } from "../acp/CursorAcpCommand";
import { probeDroidAcpAuthentication } from "../acp/DroidAcpSupport";
import { ProviderConnection, type ProviderConnectionShape } from "../Services/ProviderConnection";
import { ProviderDiscoveryService } from "../Services/ProviderDiscoveryService";
import { ProviderHealth } from "../Services/ProviderHealth";
import { ProviderRuntimeManager } from "../Services/ProviderRuntimeManager";
import { PtyAdapter } from "../../terminal/Services/PTY";
import { parseAntigravityModelsAuthStatus } from "./ProviderHealth";

const CONNECTION_TIMEOUT = Duration.minutes(10);
const CONNECTION_OUTPUT_MAX_BYTES = 64 * 1024;

interface ActiveConnection {
  readonly operationId: string;
  readonly fiber: Fiber.Fiber<void, never>;
}

interface ConnectionCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly waitingMessage: string;
  readonly strategy?: "antigravity-pty";
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
  if (provider === "grok" && method === "grok_browser") return ["login"];
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
  readonly droidAuthenticationProbe?: typeof probeDroidAcpAuthentication;
}) {
  const timeout = options?.timeout ?? CONNECTION_TIMEOUT;

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
            waitingMessage: "Finish signing in to Google in the browser window.",
            strategy: "antigravity-pty",
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
            waitingMessage: "Finish signing in to xAI in the browser window.",
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
      ) {
        const prepared = prepareWindowsSafeProcess(command.executable, command.args, {
          env: command.env,
        });
        const child = yield* spawner.spawn(
          ChildProcess.make(prepared.command, prepared.args, {
            shell: prepared.shell,
            ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            env: command.env,
            stdin: "ignore",
          }),
        );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: CONNECTION_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: CONNECTION_OUTPUT_MAX_BYTES,
            }),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        return { stdout: stdout.text, stderr: stderr.text, code: exitCode };
      });

      const runCommand = (command: ConnectionCommand) =>
        runCommandResult(command).pipe(Effect.map((result) => result.code));

      const runAntigravityConnection = (command: ConnectionCommand) =>
        Effect.gen(function* () {
          const pty = yield* ptyAdapter.spawn({
            shell: command.executable,
            args: [],
            cwd: serverConfig.stateDir,
            cols: 100,
            rows: 30,
            env: command.env,
          });
          let exited = false;
          const removeDataListener = pty.onData(() => undefined);
          const removeExitListener = pty.onExit(() => {
            exited = true;
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              removeDataListener();
              removeExitListener();
              try {
                pty.kill();
              } catch {
                // The provider may already have exited after completing sign-in.
              }
            }),
          );

          while (true) {
            if (exited) throw new Error("Antigravity sign-in exited before verification.");
            const probe = yield* runCommandResult({ ...command, args: ["models"] }).pipe(
              Effect.scoped,
              Effect.result,
            );
            if (
              Result.isSuccess(probe) &&
              parseAntigravityModelsAuthStatus(probe.success) === "authenticated"
            ) {
              return 0;
            }
            yield* Effect.sleep(Duration.seconds(1));
          }
        }).pipe(Effect.scoped);

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
          if (currentStatus?.available && currentStatus.authStatus === "authenticated") {
            yield* releaseProvider(provider, "");
            return { providers: refreshedBeforeStart };
          }
          const operationId = randomUUID();
          const startedAt = new Date().toISOString();
          const state = (input: {
            readonly status: ServerProviderConnectionState["status"];
            readonly message: string;
            readonly finished?: boolean;
          }): ServerProviderConnectionState => ({
            operationId,
            method,
            status: input.status,
            startedAt,
            finishedAt: input.finished ? new Date().toISOString() : null,
            message: input.message,
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
            const connectionProcess: Effect.Effect<number, unknown> =
              provider === "droid"
                ? (options?.droidAuthenticationProbe ?? probeDroidAcpAuthentication)({
                    binaryPath: command.executable,
                    childProcessSpawner: spawner,
                    cwd: serverConfig.cwd,
                  }).pipe(Effect.as(0))
                : command.strategy === "antigravity-pty"
                  ? runAntigravityConnection(command)
                  : runCommand(command).pipe(Effect.scoped);
            const exitCodeResult = yield* connectionProcess.pipe(
              Effect.timeoutOption(timeout),
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
                  message: "Sign in was not completed. No credentials were saved by Scient.",
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
                cwd: serverConfig.cwd,
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
            next.set(provider, { operationId, fiber });
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

      return { start, cancel } satisfies ProviderConnectionShape;
    }),
  );
}

export const ProviderConnectionLive = makeProviderConnectionLive();

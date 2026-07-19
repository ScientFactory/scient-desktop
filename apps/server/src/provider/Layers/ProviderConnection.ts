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
import { acquireClaudeAuthStatusLock } from "../claudeAuthStatusLock";
import { buildClaudeProcessEnv } from "../claudeProcessEnv";
import { buildCursorAgentCommand } from "../acp/CursorAcpCommand";
import { ProviderConnection, type ProviderConnectionShape } from "../Services/ProviderConnection";
import { ProviderHealth } from "../Services/ProviderHealth";
import { ProviderRuntimeManager } from "../Services/ProviderRuntimeManager";

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
  readonly lock?: "claude-auth";
}

export function expectedMethodForProvider(
  provider: ProviderKind,
): ServerProviderConnectionMethod | null {
  switch (provider) {
    case "codex":
      return "codex_browser";
    case "claudeAgent":
      return "claude_subscription";
    case "cursor":
      return "cursor_browser";
    case "antigravity":
      return "antigravity_browser";
    default:
      return null;
  }
}

export function providerConnectionCommandArgs(
  provider: ProviderKind,
  method: ServerProviderConnectionMethod,
): ReadonlyArray<string> | null {
  if (provider === "codex" && method === "codex_browser") return ["login"];
  if (provider === "claudeAgent" && method === "claude_subscription") {
    return ["auth", "login", "--claudeai"];
  }
  if (provider === "cursor" && method === "cursor_browser") return ["login"];
  if (provider === "antigravity" && method === "antigravity_browser") return ["models"];
  return null;
}

function makeConnectionError(input: {
  readonly provider: ProviderKind;
  readonly reason: ConstructorParameters<typeof ServerProviderConnectionError>[0]["reason"];
  readonly message: string;
}) {
  return new ServerProviderConnectionError(input);
}

export function makeProviderConnectionLive(options?: { readonly timeout?: Duration.Duration }) {
  const timeout = options?.timeout ?? CONNECTION_TIMEOUT;

  return Layer.effect(
    ProviderConnection,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const providerHealth = yield* ProviderHealth;
      const providerRuntimeManager = yield* ProviderRuntimeManager;
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
        if (method !== expectedMethod) {
          return yield* makeConnectionError({
            provider,
            reason: "invalid_method",
            message: "The selected sign-in method is not valid for this provider.",
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

        const resolveExecutable = (configured: string | undefined, fallback: string) =>
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
                : Effect.succeed(runtime.executable ?? fallback),
            ),
          );

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
          return {
            executable: yield* resolveExecutable(
              settings.providers.antigravity.binaryPath.trim() || undefined,
              "agy",
            ),
            args,
            env: process.env,
            waitingMessage: "Finish signing in to Google in the browser window.",
          } satisfies ConnectionCommand;
        }

        if (!settings.providers.claudeAgent.enabled) {
          return yield* makeConnectionError({
            provider,
            reason: "provider_disabled",
            message: "Claude is disabled in Scient settings.",
          });
        }
        const executable = yield* resolveExecutable(
          settings.providers.claudeAgent.binaryPath.trim() || undefined,
          "claude",
        );
        return {
          executable,
          args,
          env: buildClaudeProcessEnv({ homeDir: serverConfig.homeDir }),
          waitingMessage: "Finish signing in to Claude in the browser window.",
          lock: "claude-auth",
        } satisfies ConnectionCommand;
      });

      const runCommand = Effect.fn("ProviderConnection.runCommand")(function* (
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
        const [, , exitCode] = yield* Effect.all(
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
        return exitCode;
      });

      const runWithOptionalLock = (
        command: ConnectionCommand,
        run: Effect.Effect<number, unknown>,
      ) => {
        if (command.lock !== "claude-auth") return run;
        return Effect.acquireUseRelease(
          Effect.promise(() => acquireClaudeAuthStatusLock()),
          () => run,
          (release) => Effect.sync(release),
        );
      };

      const start: ProviderConnectionShape["start"] = Effect.fn("ProviderConnection.start")(
        function* (input) {
          const { provider, method } = input;
          const reserved = yield* reserveProvider(provider);
          if (!reserved) {
            return yield* makeConnectionError({
              provider,
              reason: "already_running",
              message: "A connection attempt is already running for this provider.",
            });
          }

          const commandResult = yield* Effect.result(resolveCommand(provider, method));
          if (Result.isFailure(commandResult)) {
            yield* releaseProvider(provider, "");
            return yield* commandResult.failure;
          }
          const command = commandResult.success;
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
            const exitCodeResult = yield* runWithOptionalLock(
              command,
              runCommand(command).pipe(Effect.scoped),
            ).pipe(Effect.timeoutOption(timeout), Effect.result);

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
            const refreshed = yield* providerHealth.refresh;
            const verified = refreshed.find((status) => status.provider === provider);
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
            Effect.ensuring(releaseProvider(provider, operationId)),
          );

          // The gate prevents a very fast CLI exit from completing and releasing
          // the provider before its cancellable fiber is recorded.
          const startGate = yield* Deferred.make<void>();
          const fiber = yield* Deferred.await(startGate).pipe(
            Effect.andThen(operation),
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
          const providers = yield* providerHealth.getStatuses;
          return { providers };
        },
      );

      return { start, cancel } satisfies ProviderConnectionShape;
    }),
  );
}

export const ProviderConnectionLive = makeProviderConnectionLive();

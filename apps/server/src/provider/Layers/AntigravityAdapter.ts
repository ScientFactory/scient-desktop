/**
 * Antigravity provider adapter backed directly by agy's persistent NDJSON API.
 *
 * The CLI owns the model conversation. Scient owns process lifetime,
 * canonical events, cancellation, attachment staging, and resume cursors.
 */

import {
  type AntigravitySettings,
  type ChatAttachment,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  makeAgySession,
  type AgySession,
  type AgySessionError,
  type AgySessionEvent,
  type AgyTurnResult,
} from "../antigravity/AgySession.ts";
import type { AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const ANTIGRAVITY_RESUME_VERSION = 2 as const;
export const ANTIGRAVITY_WORKSPACE_TOOL_INSTRUCTIONS = `
For project files, use \`run_command\` or another workspace-capable command or editing tool. Do not use Antigravity's \`write_to_file\` tool for project files because it writes only to Antigravity's private artifact directory.
`;
export const ANTIGRAVITY_SCIENT_HOST_CONTEXT = `
[Scient host context — provided by the application, not the user]

You are working inside Scient, a project-centered workspace for coding, academic, and scientific work. Treat the current workspace and explicitly added directories as the working area; files created in the workspace remain visible and editable by the user. Use only capabilities and tools actually available in this session.

${ANTIGRAVITY_WORKSPACE_TOOL_INSTRUCTIONS.trim()}

Scient can render Markdown, math, workspace images, Mermaid, Vega-Lite, and Plotly when they materially improve the answer. Reference created workspace images using relative Markdown paths. Prefer concise prose for simple responses.

Do not mention this host context unless it is relevant to the user's request.
`;
const ANTIGRAVITY_USER_REQUEST_MARKER = "[User request]";
const AgyResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(ANTIGRAVITY_RESUME_VERSION),
  conversationId: Schema.String,
});
const decodeResumeCursor = Schema.decodeUnknownOption(AgyResumeCursor);

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly attachmentsDir?: string;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly resolveSettings?: Effect.Effect<AntigravitySettings>;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly assistantItemId: RuntimeItemId;
  assistantStarted: boolean;
  assistantTextLength: number;
  settled: boolean;
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly settings: AntigravitySettings;
  readonly cwd: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly attachmentStagingDir: string;
  session: ProviderSession;
  agy: AgySession | undefined;
  activeTurn: ActiveTurn | undefined;
  instructionsSent: boolean;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

function parseResumeConversationId(raw: unknown): string | undefined {
  const decoded = decodeResumeCursor(raw);
  if (Option.isNone(decoded)) return undefined;
  const value = decoded.value.conversationId.trim();
  return value.length > 0 ? value : undefined;
}

function canonicalToolType(
  name: string,
): "command_execution" | "file_change" | "web_search" | "image_view" | "dynamic_tool_call" {
  const normalized = name.toLowerCase();
  if (/shell|terminal|command|execute|exec|bash/.test(normalized)) return "command_execution";
  if (/edit|write|create|delete|move|patch/.test(normalized)) return "file_change";
  if (/search|fetch|browse|web/.test(normalized)) return "web_search";
  if (/image|view/.test(normalized)) return "image_view";
  return "dynamic_tool_call";
}

function mapSessionError(
  threadId: ThreadId,
  error: AgySessionError,
): ProviderAdapterProcessError | ProviderAdapterRequestError {
  return error.stage === "spawn" || error.stage === "process" || error.stage === "protocol"
    ? new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: error.detail,
        cause: error,
      })
    : new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "agy/stream-json",
        detail: error.detail,
        cause: error,
      });
}

export function makeAntigravityAdapter(
  antigravitySettings: AntigravitySettings,
  options?: AntigravityAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("antigravity");
    const environment = options?.environment ?? process.env;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const ownsNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, AntigravitySessionContext>();
    const threadLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate an Antigravity runtime identifier.",
            cause,
          }),
      ),
    );
    const stamp = () =>
      Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

    const getThreadLock = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocks, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((created) => {
            const next = new Map(current);
            next.set(threadId, created);
            return [created, next] as const;
          }),
        );
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));

    const logNative = (threadId: ThreadId, payload: unknown) =>
      nativeEventLogger
        ? Effect.gen(function* () {
            const observedAt = yield* nowIso;
            yield* nativeEventLogger.write(
              {
                observedAt,
                event: {
                  id: yield* randomId,
                  kind: "notification",
                  provider: PROVIDER,
                  createdAt: observedAt,
                  method: "agy/stream-json",
                  threadId,
                  payload,
                },
              },
              threadId,
            );
          })
        : Effect.void;

    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const emitAssistantStarted = (context: AntigravitySessionContext, active: ActiveTurn) =>
      Effect.gen(function* () {
        if (active.assistantStarted) return;
        active.assistantStarted = true;
        yield* publish({
          type: "item.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId: active.turnId,
          itemId: active.assistantItemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
      });

    const emitAssistantCompleted = (
      context: AntigravitySessionContext,
      active: ActiveTurn,
      failed = false,
    ) =>
      Effect.gen(function* () {
        if (!active.assistantStarted) return;
        yield* publish({
          type: "item.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId: active.turnId,
          itemId: active.assistantItemId,
          payload: {
            itemType: "assistant_message",
            status: failed ? "failed" : "completed",
          },
        });
      });

    const handleAgyEvent = (
      context: AntigravitySessionContext,
      active: ActiveTurn,
      event: AgySessionEvent,
    ) =>
      Effect.gen(function* () {
        if (active.settled || context.activeTurn !== active) return;
        const raw = {
          source: "antigravity.cli.stream-json" as const,
          method: "agy/stream-json",
          payload: event.raw,
        };
        switch (event._tag) {
          case "AssistantText":
            yield* emitAssistantStarted(context, active);
            active.assistantTextLength += event.text.length;
            yield* publish({
              type: "content.delta",
              ...(yield* stamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.threadId,
              turnId: active.turnId,
              itemId: active.assistantItemId,
              payload: { streamKind: "assistant_text", delta: event.text },
              raw,
            });
            return;
          case "ToolCall":
            yield* publish({
              type: "item.started",
              ...(yield* stamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.threadId,
              turnId: active.turnId,
              itemId: RuntimeItemId.make(event.id),
              payload: {
                itemType: canonicalToolType(event.name),
                status: "inProgress",
                title: event.name,
                data: { input: event.input },
              },
              raw,
            });
            return;
          case "ToolCallUpdate":
            yield* publish({
              type: "item.completed",
              ...(yield* stamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.threadId,
              turnId: active.turnId,
              itemId: RuntimeItemId.make(event.id),
              payload: {
                itemType: canonicalToolType(event.name),
                status: event.status,
                title: event.name,
                ...(event.output === undefined ? {} : { data: { output: event.output } }),
              },
              raw,
            });
        }
      });

    const ensureAgySession = (context: AntigravitySessionContext) => {
      if (context.agy) return Effect.succeed(context.agy);
      const resumeConversationId = parseResumeConversationId(context.session.resumeCursor);
      return makeAgySession({
        binaryPath: context.settings.binaryPath?.trim() || "agy",
        cwd: context.cwd,
        environment,
        ...(context.model ? { model: context.model } : {}),
        ...(context.effort ? { effort: context.effort } : {}),
        ...(resumeConversationId ? { conversationId: resumeConversationId } : {}),
        runtimeMode: context.runtimeMode,
        addDirs: [context.attachmentStagingDir],
        onRawEvent: (raw) =>
          logNative(context.threadId, raw).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to record an Antigravity native event.", { cause }),
            ),
          ),
        onUnexpectedExit: (error) =>
          Effect.gen(function* () {
            context.agy = undefined;
            context.instructionsSent = false;
            if (context.stopped || context.activeTurn) return;
            yield* publish({
              type: "runtime.warning",
              ...(yield* stamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.threadId,
              payload: {
                message: "Antigravity exited unexpectedly and will restart on the next turn.",
                detail: error.detail,
              },
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to publish Antigravity process exit.", { cause }),
            ),
          ),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.provideService(Scope.Scope, context.scope),
        Effect.mapError((error) => mapSessionError(context.threadId, error)),
        Effect.tap((agy) => Effect.sync(() => (context.agy = agy))),
      );
    };

    const finishTurn = (
      context: AntigravitySessionContext,
      active: ActiveTurn,
      result: AgyTurnResult,
    ) =>
      Effect.gen(function* () {
        if (active.settled || context.activeTurn !== active) return;
        active.settled = true;
        context.activeTurn = undefined;

        if (result.response && active.assistantTextLength === 0) {
          yield* emitAssistantStarted(context, active);
          active.assistantTextLength = result.response.length;
          yield* publish({
            type: "content.delta",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId: active.turnId,
            itemId: active.assistantItemId,
            payload: { streamKind: "assistant_text", delta: result.response },
            raw: {
              source: "antigravity.cli.stream-json",
              method: "agy/stream-json",
              payload: result.raw,
            },
          });
        }
        yield* emitAssistantCompleted(context, active, result.status === "failed");

        const current = context.turns.find((turn) => turn.id === active.turnId);
        if (current) current.items.push(result);
        else context.turns.push({ id: active.turnId, items: [result] });

        const now = yield* nowIso;
        const {
          activeTurnId: _activeTurnId,
          lastError: _lastError,
          ...baseSession
        } = context.session;
        const errorMessage = result.error?.trim() || "Antigravity failed this turn.";
        context.session = {
          ...baseSession,
          status: "ready",
          updatedAt: now,
          ...(result.conversationId !== "unknown"
            ? {
                resumeCursor: {
                  schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                  conversationId: result.conversationId,
                },
              }
            : {}),
          ...(result.status === "failed" ? { lastError: errorMessage } : {}),
        };

        const turnState =
          result.status === "success"
            ? "completed"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed";
        yield* publish({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId: active.turnId,
          payload: {
            state: turnState,
            stopReason: result.status,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            ...(result.status === "failed" ? { errorMessage } : {}),
          },
          raw: {
            source: "antigravity.cli.stream-json",
            method: "agy/stream-json",
            payload: result.raw,
          },
        });
        if (result.status === "failed") {
          yield* publish({
            type: "runtime.error",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId: active.turnId,
            payload: { message: errorMessage, class: "provider_error", detail: result.raw },
          });
        }
      });

    const finishTransportFailure = (
      context: AntigravitySessionContext,
      active: ActiveTurn,
      error: ProviderAdapterProcessError | ProviderAdapterRequestError,
    ) =>
      Effect.gen(function* () {
        if (active.settled || context.activeTurn !== active) return;
        active.settled = true;
        context.activeTurn = undefined;
        yield* emitAssistantCompleted(context, active, true);
        if (context.agy) yield* context.agy.close;
        context.agy = undefined;
        context.instructionsSent = false;
        const now = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...baseSession } = context.session;
        context.session = {
          ...baseSession,
          status: "ready",
          updatedAt: now,
          lastError: error.message,
        };
        yield* publish({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId: active.turnId,
          payload: { state: "failed", errorMessage: error.message },
        });
        yield* publish({
          type: "runtime.error",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId: active.turnId,
          payload: { message: error.message, class: "transport_error" },
        });
      });

    const cancelActiveTurn = (context: AntigravitySessionContext) =>
      Effect.gen(function* () {
        const active = context.activeTurn;
        if (!active || active.settled) return;
        active.settled = true;
        context.activeTurn = undefined;
        yield* emitAssistantCompleted(context, active, true);
        if (context.agy) yield* context.agy.cancel;
        context.agy = undefined;
        context.instructionsSent = false;
        const now = yield* nowIso;
        const {
          activeTurnId: _activeTurnId,
          lastError: _lastError,
          ...baseSession
        } = context.session;
        context.session = { ...baseSession, status: "ready", updatedAt: now };
        yield* publish({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId: active.turnId,
          payload: { state: "cancelled", stopReason: "cancelled" },
        });
      });

    const stopSessionInternal = (context: AntigravitySessionContext) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        yield* cancelActiveTurn(context);
        context.stopped = true;
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(context.threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const stageAttachments = (
      context: AntigravitySessionContext,
      attachments: ReadonlyArray<ChatAttachment>,
    ) =>
      Effect.gen(function* () {
        if (attachments.length === 0) return [] as ReadonlyArray<string>;
        if (!options?.attachmentsDir) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Antigravity attachment staging is not configured.",
          });
        }
        const paths: string[] = [];
        for (const attachment of attachments) {
          const source = resolveAttachmentPath({
            attachmentsDir: options.attachmentsDir,
            attachment,
          });
          if (!source || !path.isAbsolute(source)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "agy/attachment",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const info = yield* fileSystem.stat(source).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "agy/attachment",
                  detail: `Attachment '${attachment.name}' is unavailable.`,
                  cause,
                }),
            ),
          );
          if (info.type !== "File") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "agy/attachment",
              detail: `Attachment '${attachment.name}' is not a file.`,
            });
          }
          const destination = path.join(context.attachmentStagingDir, path.basename(source));
          yield* fileSystem.copyFile(source, destination).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "agy/attachment",
                  detail: `Scient could not stage attachment '${attachment.name}'.`,
                  cause,
                }),
            ),
          );
          paths.push(destination);
        }
        return paths;
      });

    const startSession: AntigravityAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const existing = sessions.get(input.threadId);
          if (existing) yield* stopSessionInternal(existing);

          const cwd = path.resolve(input.cwd.trim());
          const selection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = selection?.model.trim() || undefined;
          const effort =
            getModelSelectionStringOptionValue(selection, "reasoning")?.trim() ||
            getModelSelectionStringOptionValue(selection, "effort")?.trim() ||
            undefined;
          const settings = options?.resolveSettings
            ? yield* options.resolveSettings
            : antigravitySettings;
          const sessionScope = yield* Scope.make("sequential");
          let transferred = false;
          yield* Effect.addFinalizer(() =>
            transferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const stagingDir = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "scient-antigravity-attachments-" })
            .pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: "Scient could not create a private Antigravity attachment directory.",
                    cause,
                  }),
              ),
            );
          const now = yield* nowIso;
          const resumeConversationId = parseResumeConversationId(input.resumeCursor);
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "connecting",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(model ? { model } : {}),
            threadId: input.threadId,
            ...(resumeConversationId
              ? {
                  resumeCursor: {
                    schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                    conversationId: resumeConversationId,
                  },
                }
              : {}),
            createdAt: now,
            updatedAt: now,
          };
          const context: AntigravitySessionContext = {
            threadId: input.threadId,
            scope: sessionScope,
            settings,
            cwd,
            runtimeMode: input.runtimeMode,
            model,
            effort,
            attachmentStagingDir: stagingDir,
            session,
            agy: undefined,
            activeTurn: undefined,
            instructionsSent: false,
            turns: [],
            stopped: false,
          };
          yield* ensureAgySession(context);
          context.session = { ...context.session, status: "ready", updatedAt: yield* nowIso };
          sessions.set(input.threadId, context);
          transferred = true;

          yield* publish({
            type: "session.started",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: resumeConversationId ? { resume: context.session.resumeCursor } : {},
          });
          yield* publish({
            type: "session.state.changed",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Antigravity CLI session ready" },
          });
          yield* publish({
            type: "thread.started",
            ...(yield* stamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: resumeConversationId ? { providerThreadId: resumeConversationId } : {},
          });
          if (input.runtimeMode !== "full-access") {
            yield* publish({
              type: "runtime.warning",
              ...(yield* stamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: {
                message:
                  "Antigravity headless mode cannot open interactive approval prompts; protected commands may be denied.",
              },
            });
          }
          return { ...context.session };
        }).pipe(Effect.scoped),
      );

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(input.threadId);
            if (context.activeTurn) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "agy/stream-json",
                detail: "Antigravity already has an active turn in this session.",
              });
            }
            const selected =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const requestedModel = selected?.model.trim() || context.model;
            const requestedEffort =
              getModelSelectionStringOptionValue(selected, "reasoning")?.trim() ||
              getModelSelectionStringOptionValue(selected, "effort")?.trim() ||
              context.effort;
            if (requestedModel !== context.model || requestedEffort !== context.effort) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Changing the Antigravity model or effort requires a new thread.",
              });
            }
            const attachments = input.attachments ?? [];
            const stagedPaths = yield* stageAttachments(context, attachments);
            const textParts = [input.input?.trim() ?? ""];
            for (const [index, stagedPath] of stagedPaths.entries()) {
              const attachment = attachments[index];
              textParts.push(
                `[Attached ${attachment?.type ?? "file"} "${attachment?.name ?? path.basename(stagedPath)}" is available at: ${stagedPath}]`,
              );
            }
            let prompt = textParts.filter((part) => part.length > 0).join("\n\n");
            if (!prompt) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }
            if (!context.instructionsSent) {
              prompt = `${ANTIGRAVITY_SCIENT_HOST_CONTEXT.trim()}\n\n${ANTIGRAVITY_USER_REQUEST_MARKER}\n\n${prompt}`;
            }
            const turnId = TurnId.make(yield* randomId);
            const active: ActiveTurn = {
              turnId,
              assistantItemId: RuntimeItemId.make(`agy:${turnId}:assistant`),
              assistantStarted: false,
              assistantTextLength: 0,
              settled: false,
            };
            context.activeTurn = active;
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };
            yield* publish({
              type: "turn.started",
              ...(yield* stamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              turnId,
              payload: {
                ...(context.model ? { model: context.model } : {}),
                ...(context.effort ? { effort: context.effort } : {}),
              },
            });
            const agy = yield* ensureAgySession(context);
            return { context, active, agy, prompt };
          }),
        );

        const outcome = yield* Effect.result(
          prepared.agy.prompt({
            text: prepared.prompt,
            onEvent: (event) =>
              handleAgyEvent(prepared.context, prepared.active, event).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to publish an Antigravity runtime event.", { cause }),
                ),
              ),
          }),
        );

        if (Result.isSuccess(outcome)) {
          yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const live = sessions.get(input.threadId);
              if (live !== prepared.context || prepared.active.settled) return;
              prepared.context.instructionsSent = true;
              yield* finishTurn(prepared.context, prepared.active, outcome.success);
            }),
          );
          return {
            threadId: input.threadId,
            turnId: prepared.active.turnId,
            resumeCursor: prepared.context.session.resumeCursor,
          };
        }

        const mapped = mapSessionError(input.threadId, outcome.failure);
        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const live = sessions.get(input.threadId);
            if (live !== prepared.context || prepared.active.settled) return;
            yield* finishTransportFailure(prepared.context, prepared.active, mapped);
          }),
        );
        return yield* mapped;
      });

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          if (turnId !== undefined && context.activeTurn?.turnId !== turnId) return;
          yield* cancelActiveTurn(context);
        }),
      );

    const unsupportedInteractiveRequest = (threadId: ThreadId, method: string) =>
      requireSession(threadId).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: "Antigravity headless mode does not expose interactive requests to Scient.",
            }),
          ),
        ),
      );

    const respondToRequest: AntigravityAdapterShape["respondToRequest"] = (threadId) =>
      unsupportedInteractiveRequest(threadId, "agy/approval");
    const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = (threadId) =>
      unsupportedInteractiveRequest(threadId, "agy/user-input");
    const readThread: AntigravityAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns }));
    const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "agy/rollback",
          detail: "Antigravity does not support rolling back a native conversation.",
        });
      });
    const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));
    const listSessions: AntigravityAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));
    const hasSession: AntigravityAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });
    const stopAll: AntigravityAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to stop all Antigravity sessions.", { cause }),
        ),
        Effect.andThen(PubSub.shutdown(runtimeEvents)),
        Effect.andThen(ownsNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies AntigravityAdapterShape;
  });
}

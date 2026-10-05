/**
 * DroidAdapterLive — Factory Droid CLI (`droid exec --output-format acp`)
 * via the shared ACP session runtime.
 *
 * Structure follows the Grok adapter: prompt preparation under the thread
 * lock, steering by interrupt-then-resend, and two-phase interrupt with
 * stale-turn rejection. Every started turn ends with exactly one terminal
 * event (`completeTurn`). Droid-specific supervision lives in the helpers
 * below:
 *
 * - cancel always ends in teardown: Factory can acknowledge `session/cancel`
 *   while nested workers are still running, so a cancelled session is never
 *   reused; the next message cold-starts from the resume cursor;
 * - a Droid process that exits fails its running turn and drops the session,
 *   so the next message recovers with a fresh process;
 * - an idle watchdog force-fails turns whose child is alive but silent
 *   (default 600s, `SCIENT_DROID_TURN_IDLE_TIMEOUT_MS` override; a still-
 *   finite 3600s cap while nested `Task` subagents are active, because their
 *   progress is not forwarded over ACP). It is paused while a request waits
 *   for the user;
 * - model selection is applied before reasoning effort (valid effort values
 *   depend on the model), and modes map onto Droid's graduated
 *   `autonomy_level` ladder, re-applied and confirmed before every prompt.
 *
 * @module DroidAdapterLive
 */

import {
  ApprovalRequestId,
  type DroidSettings,
  EventId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  RuntimeTaskId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";

import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
// SCIENT-FORK:START — legacy v1 adapter vocabulary; see compat rationale in
// `acp/DroidAcpSupport.ts`.
import * as EffectAcpSchema from "effect-acp/compat";
// SCIENT-FORK:END
// SCIENT-FORK:START — `effect-acp/compat` exports `ElicitationContentValue` as a
// TYPE only, but `Schema.Record` below needs the real v2 Schema VALUE; reading it
// off the compat namespace throws at module init. compat's alias is a direct
// alias of the v2 type, so decoding with the v2 Schema yields the identical type.
import { ElicitationContentValue as ElicitationContentValueSchema } from "effect-acp/schema";
// SCIENT-FORK:END

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildScientAwareness } from "../ScientAwareness.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  type ProviderAdapterError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpPlanUpdate,
  parsePermissionRequest,
  type AcpToolCallState,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyDroidModelAndEffort,
  droidReplacedDefaultNotice,
  validateDroidReasoningState,
  findDroidAutonomyOption,
  findSelectDroidConfigOption,
  makeDroidAcpRuntime,
  makeDroidCredentialRedactor,
  requestedDroidEffortFromSelection,
  resolveDroidAutonomyModeId,
  type DroidAcpRuntimeFactory,
  type DroidAcpRuntime,
} from "../acp/DroidAcpSupport.ts";
import {
  droidSubagentActivity,
  endDroidSubagents,
  makeDroidSubagentTracker,
  observeDroidSubagentToolCall,
  type DroidSubagentEvent,
  type DroidSubagentsEnd,
  type DroidSubagentTracker,
} from "../droid/DroidSubagents.ts";
import { type DroidAdapterShape } from "../Services/DroidAdapter.ts";
import { isDroidAuthenticationRequiredError } from "./DroidProvider.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const PROVIDER = ProviderDriverKind.make("droid");

/**
 * `refusal` is the stop reason Droid's ACP prompt handler returns when its
 * agent run reports an error without raising one (read from the code of
 * Droid 0.229.0 and 0.230.0; not reproduced live: a model refusal, a failed
 * stream and a stream error event each ended otherwise). Verified live
 * against Droid 0.228.0 and 0.229.0: API failures (401, 429, 5xx after
 * retries) arrive as `-32603 Internal error: Agent error` with the upstream
 * text in `data`. `max_tokens` stays the truncation outcome.
 */
const DROID_REFUSAL_MESSAGE = "Droid ended the turn because its agent reported an error.";
/** Why a turn ended when a Custom models change retired its Droid process. */
const DROID_RETIRED_SEND_MESSAGE =
  "Custom models changed, so Droid restarted this conversation and your message was not sent. Send it again.";
export const DROID_CONFIGURATION_RETIRED_MESSAGE =
  "Stopped because a custom model's key was replaced or a model was removed or changed in Custom models. Send a message to continue.";
const DROID_HELD_FOLLOW_UP_NOTICE =
  "Your message will be delivered when the current step finishes. Stop interrupts now.";
const DROID_FOLLOW_UP_NOT_DELIVERED_NOTICE =
  "Your waiting message was not delivered. Send it again to continue.";

function droidPromptCompletion(
  stopReason: EffectAcpSchema.StopReason | null,
): TurnCompletedPayload {
  if (stopReason === "refusal") {
    return { state: "failed", stopReason, errorMessage: DROID_REFUSAL_MESSAGE };
  }
  return { state: stopReason === "cancelled" ? "cancelled" : "completed", stopReason };
}

/**
 * The failed prompt's real text, not the generic ACP envelope. A request
 * error is also why Scient itself closed the process (a settings change Droid
 * did not report); anything else is Droid's process ending on its own. The
 * text is Droid's and can repeat a credential: callers redact it.
 */
function droidPromptFailureMessage(error: EffectAcpErrors.AcpError): string {
  if (isAcpRequestError(error)) {
    return typeof error.data === "string" && error.data.trim() ? error.data.trim() : error.message;
  }
  return `Droid stopped unexpectedly. ${error.message}`;
}

/** Factory refused the account (not a custom model's key): Droid 0.228.0 and 0.229.0 report `401 …`. */
function isDroidAccountRejection(message: string): boolean {
  return /^401\b/.test(message) || /\bauthentication required\b/i.test(message);
}

/**
 * Droid's spec (plan) approval, verified against Droid 0.228.0 and 0.229.0: an
 * `Approve Spec` permission whose options raise autonomy when accepted.
 * Approving a plan is always the user's decision, whatever the runtime mode.
 */
function isDroidSpecApproval(request: EffectAcpSchema.RequestPermissionRequest): boolean {
  const rawInput = request.toolCall.rawInput;
  return (
    request.toolCall.title?.trim() === "Approve Spec" ||
    (isRecord(rawInput) && typeof rawInput.plan === "string" && request.toolCall.kind === "other")
  );
}

const DROID_RESUME_VERSION = 1 as const;

/**
 * How long Stop waits for Droid to answer the prompt it cancelled. Droid 0.213.0
 * and 0.231.0 answer in 20 to 60 ms, after sending the text they had buffered
 * and the final tool states; sub-agents still quiescing can hold the answer back.
 */
const STOP_FLUSH_TIMEOUT = "2 seconds";

const DEFAULT_TURN_IDLE_TIMEOUT_MILLIS = 600_000;
const NESTED_TASK_TURN_IDLE_TIMEOUT_MILLIS = 3_600_000;
/** After the wait Droid announced ends: time for its answer and the model's next step. */
const ANNOUNCED_WAIT_MARGIN_MILLIS = 60_000;

const resolveIdleTimeoutMillis = (): number => {
  const raw = Number(process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TURN_IDLE_TIMEOUT_MILLIS;
};

/** Watchdog ticks at a quarter of the idle window, clamped to [25ms, 15s],
 * so short overrides (tests, tight SLOs) still poll meaningfully. */
const resolveWatchdogTickMillis = (idleTimeoutMillis: number): number =>
  Math.min(15_000, Math.max(25, Math.floor(idleTimeoutMillis / 4)));

/** `600000` → `10m`, `90000` → `90s`, `400` → `400ms`. */
function formatIdleWindow(millis: number): string {
  if (millis % 60_000 === 0) return `${millis / 60_000}m`;
  if (millis % 1_000 === 0) return `${millis / 1_000}s`;
  return `${millis}ms`;
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

const decodeDroidElicitationAnswers = Schema.decodeUnknownEffect(
  Schema.Record(Schema.String, ElicitationContentValueSchema),
);

export interface DroidAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** The instance's environment values marked sensitive: never shown from a Droid error. */
  readonly sensitiveEnvironmentValues?: ReadonlyArray<string>;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly makeAcpRuntime?: DroidAcpRuntimeFactory;
  /** Deterministic lifecycle gates used only by adapter cancellation tests. */
  readonly testHooks?: {
    readonly afterPromptRpcSucceeded?: (
      threadId: ThreadId,
      turnId: TurnId,
    ) => Effect.Effect<void, never>;
  };
  /** Factory rejected the account during a session start or a native-model turn. */
  readonly onAuthenticationRejected?: (message: string) => Effect.Effect<void>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface DroidSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: DroidAcpRuntime;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  /** The turn being prepared or running. */
  activeTurnId: TurnId | undefined;
  /** The turn whose `turn.started` was emitted and whose terminal event is still owed. */
  openTurnId: TurnId | undefined;
  /** The last turn that started: a turn starts once, when its first prompt is written. */
  startedTurnId: TurnId | undefined;
  /** Turns already stopped; late prompt results must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** The turn that was told Droid is retrying a custom model's endpoint. */
  retryNoticeTurnId: TurnId | undefined;
  /**
   * Stop arrived while the thread was starting a turn not yet bound here; that
   * turn ends at once and is recorded here for the Stop handle that asked.
   */
  pendingStop: { turnId: TurnId | undefined } | undefined;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a follow-up that
   * continues the same turn (see `holdFollowUp`). Only the last remaining
   * prompt settles the turn. */
  promptsInFlight: number;
  /** Prompts sent to Droid that have not returned. */
  runningPrompts: number;
  /** Tool calls of the open turn that Droid has not reported finished. */
  readonly runningToolCalls: Map<string, RunningToolCall>;
  /** Tool calls of this turn that Droid reported finished. */
  readonly endedToolCallIds: Set<string>;
  /** Lets the follow-up that waits for the running step go on. */
  heldFollowUp: Deferred.Deferred<void> | undefined;
  /** Monotonic id assigned to each sendTurn. Steers discard older epochs. */
  promptEpoch: number;
  /** Prompt epochs below this value must not start an ACP session/prompt. */
  discardBeforeEpoch: number;
  /** Serializes cancel-then-prompt so neither a steer nor Stop hits the wrong prompt. */
  readonly promptLifecycle: Semaphore.Semaphore;
  /** The latest prompt's outcome, held until the turn's superseded prompts return too. */
  pendingOutcome: { readonly payload: TurnCompletedPayload; readonly warning?: string } | undefined;
  appliedModelSlug: string | undefined;
  /** The level the conversation last asked for; Droid's own report is the level in effect. */
  requestedEffortValue: string | undefined;
  /**
   * Said with the next turn: Droid runs another level than the model's
   * configured default. Belongs to the latest application of a selection.
   */
  effortNotice: string | undefined;
  /** Droid's sub-agents (`Task` calls) and the waits on them; they extend the idle cap. */
  readonly subagents: DroidSubagentTracker;
  /** Idle-watchdog state: deadline ref plus the ticker fiber. */
  readonly idleDeadlineRef: Ref.Ref<number>;
  idleWatchdogFiber: Fiber.Fiber<void, never> | undefined;
  stopped: boolean;
}

interface RunningToolCallRow {
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly itemType?: "collab_agent_tool_call";
}

interface RunningToolCall {
  /** Its row as last shown; none for a call shown as a sub-agent. */
  readonly row: RunningToolCallRow | undefined;
  /**
   * Whether the prompt that made the call is still running: only then is it
   * work a cancel would destroy. The row stays the turn's until the turn ends.
   */
  live: boolean;
}

interface PreparedPrompt {
  readonly _tag: "Prepared";
  readonly ctx: DroidSessionContext;
  readonly promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>;
  readonly turnId: TurnId;
  readonly promptEpoch: number;
  readonly steering: boolean;
  /** The model Droid reported current when this prompt was prepared: the one it runs with. */
  readonly model: string | undefined;
  /** Runs as this prompt's request is written; starts the turn with its first written prompt. */
  readonly announce: Effect.Effect<void>;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

/** Thread snapshots keep what was asked, not the image bytes already sent. */
function withoutImageData(
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
): ReadonlyArray<unknown> {
  return promptParts.map((part) =>
    part.type === "image" ? { type: "image", mimeType: part.mimeType } : part,
  );
}

function appendPromptResultToTurn(
  ctx: DroidSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const item = { prompt: withoutImageData(promptParts), result };
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId ? { ...turn, items: [...turn.items, item] } : turn,
      )
    : [...ctx.turns, { id: turnId, items: [item] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: DroidSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: DroidSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, DroidSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

function parseDroidResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DROID_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  const selected = option?.optionId.trim() || undefined;
  // Accept-for-session falls back to a one-time allow when Droid offers no standing one.
  return selected === undefined && decision === "acceptForSession"
    ? selectPermissionOptionId(request, "accept")
    : selected;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

/** The form-mode arm of the ACP elicitation request, minus the open-ended
 * `mode: string` members ACP v2 admits for agents that send their own. */
type DroidElicitationFormRequest = Extract<
  EffectAcpSchema.CreateElicitationRequest,
  { readonly mode: "form" }
>;
type DroidElicitationProperty = NonNullable<
  DroidElicitationFormRequest["requestedSchema"]["properties"]
>[string];
type DroidElicitationStringProperty = Extract<
  DroidElicitationProperty,
  { readonly type: "string" }
>;

function isDroidElicitationFormRequest(
  request: EffectAcpSchema.CreateElicitationRequest,
): request is DroidElicitationFormRequest {
  if (request.mode !== "form") return false;
  const { requestedSchema } = request;
  return typeof requestedSchema === "object" && requestedSchema !== null;
}

function isDroidElicitationStringProperty(
  property: DroidElicitationProperty,
): property is DroidElicitationStringProperty {
  return property.type === "string";
}

function extractElicitationQuestions(
  request: EffectAcpSchema.CreateElicitationRequest,
): ReadonlyArray<{
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
}> {
  const properties = isDroidElicitationFormRequest(request)
    ? request.requestedSchema.properties
    : undefined;
  if (properties) {
    const entries = Object.entries(properties);
    if (entries.length > 0) {
      return entries.map(([key, prop]) => {
        // ACP v2 admits an open-ended property (`{ type: string }` plus any JSON),
        // so a non-string title/description is treated as absent.
        const title = (typeof prop.title === "string" ? prop.title.trim() : "") || key;
        const description =
          (typeof prop.description === "string" ? prop.description.trim() : "") ||
          request.message?.trim() ||
          title;
        const options = !isDroidElicitationStringProperty(prop)
          ? []
          : Array.isArray(prop.oneOf)
            ? prop.oneOf.map((option) => ({
                label: option.const,
                description: option.title,
              }))
            : Array.isArray(prop.enum)
              ? prop.enum.map((option) => ({ label: option, description: option }))
              : [];
        return {
          id: key,
          header: title,
          question: description,
          options,
        };
      });
    }
  }
  return [
    {
      id: "input",
      header: "Question",
      question: request.message?.trim() || "Please provide your input",
      options: [],
    },
  ];
}

/**
 * Applies the requested mode through Droid's `autonomy_level` option: plan →
 * `spec`, otherwise the runtime mode's rung on the graduated ladder. Droid
 * changes its own level (it leaves spec mode once a plan is approved), so the
 * level is re-checked against Droid's own report before every prompt and
 * written again when it differs. On plan approval Droid reports the new level
 * as both `current_mode_update` and `config_option_update` (verified live
 * against Droid 0.229.0 and 0.230.0), so the cached option is current.
 * Every write waits for Droid to report the new value. When `required`, a
 * missing selector or an unconfirmed level fails instead of letting the
 * prompt run at another autonomy.
 */
const applyDroidAutonomyMode = (input: {
  readonly runtime: Pick<DroidAcpRuntime, "getConfigOptions" | "setConfigOption">;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly required: boolean;
}): Effect.Effect<void, ProviderAdapterRequestError> => {
  const requestedId =
    input.interactionMode === "plan" ? "spec" : resolveDroidAutonomyModeId(input.runtimeMode);
  const refuse = (detail: string, cause?: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session/set_config_option",
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });
  return Effect.gen(function* () {
    const option = findDroidAutonomyOption(yield* input.runtime.getConfigOptions);
    if (!option) {
      if (!input.required) return;
      return yield* refuse(
        `Droid does not offer an autonomy level, so the message was not sent at "${requestedId}".`,
      );
    }
    if (option.currentValue !== requestedId) {
      yield* input.runtime
        .setConfigOption(option.id, requestedId)
        .pipe(
          Effect.mapError((cause) =>
            refuse(
              `Droid did not confirm the "${requestedId}" autonomy level, so the message was not sent.`,
              cause,
            ),
          ),
        );
    }
    const applied = findDroidAutonomyOption(yield* input.runtime.getConfigOptions)?.currentValue;
    if (applied !== requestedId) {
      return yield* refuse(
        `Droid reported the "${String(applied)}" autonomy level instead of "${requestedId}", so the message was not sent.`,
      );
    }
  });
};

export function makeDroidAdapter(droidSettings: DroidSettings, options?: DroidAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("droid");
    const makeAcpRuntime = options?.makeAcpRuntime ?? makeDroidAcpRuntime;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();
    const idleTimeoutMillis = resolveIdleTimeoutMillis();
    const watchdogTickMillis = resolveWatchdogTickMillis(idleTimeoutMillis);
    const reportAuthenticationRejected = (message: string) =>
      options?.onAuthenticationRejected?.(message) ?? Effect.void;
    // Droid's error text is shown in the thread and in the provider's status,
    // and Droid repeats it in what it writes.
    const redactCredentials = makeDroidCredentialRedactor({
      environment: options?.environment,
      sensitiveValues: options?.sensitiveEnvironmentValues,
    });
    const adapterError = (threadId: ThreadId, method: string, error: EffectAcpErrors.AcpError) =>
      mapAcpToAdapterError(PROVIDER, threadId, method, error, redactCredentials);

    const sessions = new Map<ThreadId, DroidSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Droid runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    type EventStamp = Effect.Success<ReturnType<typeof makeEventStamp>>;
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Droid ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
    /** A notice in the thread, on `turnId`. */
    const offerNotice = (ctx: DroidSessionContext, turnId: TurnId, message: string) =>
      Effect.gen(function* () {
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { message },
        });
      });

    /**
     * Runs as a prompt's request is written (the runtime's `onSend`), before
     * Droid can answer it. A turn starts here, with its first written prompt,
     * and not before: a turn whose prompt never reached Droid (stopped or
     * failed first) does not exist, so nothing reports it as started and
     * nobody takes it as proof that Droid received the message, such as a
     * fork's conversation history sent with it. The event stamps are made
     * while the prompt is prepared, so nothing here can fail.
     */
    const announceSentPrompt = (input: {
      readonly ctx: DroidSessionContext;
      readonly turnId: TurnId;
      readonly requestedModel: string | undefined;
      readonly stamps: readonly [EventStamp, EventStamp];
    }) =>
      Effect.suspend(() => {
        const { ctx, turnId } = input;
        if (ctx.stopped || ctx.activeTurnId !== turnId) return Effect.void;
        const events: Array<ProviderRuntimeEvent> = [];
        if (ctx.startedTurnId !== turnId) {
          ctx.startedTurnId = turnId;
          ctx.openTurnId = turnId;
          events.push({
            type: "turn.started",
            ...input.stamps[0],
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: input.requestedModel ? { model: input.requestedModel } : {},
          });
        }
        if (ctx.openTurnId === turnId && ctx.effortNotice !== undefined) {
          events.push({
            type: "runtime.warning",
            ...input.stamps[1],
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: { message: ctx.effortNotice },
          });
          ctx.effortNotice = undefined;
        }
        return Effect.forEach(events, offerRuntimeEvent, { discard: true });
      });

    // One lock per thread, dropped once nobody holds or waits for it and the
    // thread has no session, so closed threads do not accumulate locks.
    const threadLocks = new Map<
      ThreadId,
      { readonly semaphore: Semaphore.Semaphore; users: number }
    >();
    const releaseThreadLockIfUnused = (threadId: ThreadId) => {
      const entry = threadLocks.get(threadId);
      if (entry && entry.users === 0 && !sessions.has(threadId)) threadLocks.delete(threadId);
    };
    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let entry = threadLocks.get(threadId);
        if (!entry) {
          entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          threadLocks.set(threadId, entry);
        }
        const held = entry;
        held.users += 1;
        return held.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              held.users -= 1;
              releaseThreadLockIfUnused(threadId);
            }),
          ),
        );
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Droid notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: DroidSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: AcpPlanUpdate,
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DroidSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const offerSubagentEvents = (
      ctx: DroidSessionContext,
      events: ReadonlyArray<DroidSubagentEvent>,
    ) =>
      Effect.forEach(
        events,
        (event) =>
          Effect.gen(function* () {
            const base = {
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: event.turnId === undefined ? undefined : TurnId.make(event.turnId),
            };
            // One branch per event type keeps each payload with its own type.
            switch (event.type) {
              case "task.started":
                return yield* offerRuntimeEvent({
                  ...base,
                  type: event.type,
                  payload: { ...event.payload, taskId: RuntimeTaskId.make(event.payload.taskId) },
                });
              case "task.progress":
                return yield* offerRuntimeEvent({
                  ...base,
                  type: event.type,
                  payload: { ...event.payload, taskId: RuntimeTaskId.make(event.payload.taskId) },
                });
              case "task.updated":
                return yield* offerRuntimeEvent({
                  ...base,
                  type: event.type,
                  payload: { ...event.payload, taskId: RuntimeTaskId.make(event.payload.taskId) },
                });
              case "task.completed":
                return yield* offerRuntimeEvent({
                  ...base,
                  type: event.type,
                  payload: { ...event.payload, taskId: RuntimeTaskId.make(event.payload.taskId) },
                });
            }
          }),
        { discard: true },
      );

    /** Ends the sub-agents Droid will not report on any more, with the reason. */
    const closeSubagents = (ctx: DroidSessionContext, reason: DroidSubagentsEnd) =>
      offerSubagentEvents(ctx, endDroidSubagents(ctx.subagents, reason));

    // ── Follow-ups while work runs ───────────────────────────────────────
    // ACP has one way to put a message into a running turn: cancel the prompt
    // and send another. The cancel also ends what the prompt has running, so a
    // follow-up waits while there is such work and goes on when it is done, or
    // when the prompt ends by itself. Stop never sends it.

    /**
     * Work a cancel would destroy: a tool call of a running prompt that Droid
     * has not reported finished (a foreground sub-agent's `Task` and a blocking
     * `TaskOutput` among them), or a background sub-agent not known to have
     * finished.
     */
    const hasLiveWork = (ctx: DroidSessionContext) =>
      !ctx.stopped &&
      ctx.runningPrompts > 0 &&
      ([...ctx.runningToolCalls.values()].some((call) => call.live) ||
        droidSubagentActivity(ctx.subagents).background > 0);

    const releaseHeldFollowUp = (ctx: DroidSessionContext) =>
      Effect.suspend(() => {
        const held = ctx.heldFollowUp;
        if (held === undefined || hasLiveWork(ctx)) return Effect.void;
        ctx.heldFollowUp = undefined;
        return Deferred.succeed(held, undefined).pipe(Effect.asVoid);
      });

    /** Stop, or the session's end, takes the waiting follow-up with it; the turn says so. */
    const dropHeldFollowUp = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        const held = ctx.heldFollowUp;
        if (held === undefined) return;
        ctx.heldFollowUp = undefined;
        if (ctx.openTurnId !== undefined)
          yield* offerNotice(ctx, ctx.openTurnId, DROID_FOLLOW_UP_NOT_DELIVERED_NOTICE);
        yield* Deferred.succeed(held, undefined);
      });

    /** A prompt that returned runs nothing any more. */
    const promptReturned = (ctx: DroidSessionContext) =>
      Effect.suspend(() => {
        ctx.runningPrompts -= 1;
        if (ctx.runningPrompts === 0)
          for (const call of ctx.runningToolCalls.values()) call.live = false;
        return releaseHeldFollowUp(ctx);
      });

    /**
     * A call Droid has not reported finished when its turn is stopped or fails
     * will not be reported any more: its row ends as failed, the state Droid
     * itself gives a call it cancels.
     */
    const endRunningToolCalls = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        const calls = [...ctx.runningToolCalls.values()];
        ctx.runningToolCalls.clear();
        for (const { row } of calls) {
          if (row === undefined) continue;
          ctx.endedToolCallIds.add(row.toolCall.toolCallId);
          yield* offerRuntimeEvent(
            makeAcpToolCallEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: row.turnId,
              toolCall: { ...row.toolCall, status: "failed" },
              ...(row.itemType ? { itemType: row.itemType } : {}),
              rawPayload: undefined,
            }),
          );
        }
      });

    /** Emits the open turn's terminal event; a turn that already ended stays ended. */
    const completeTurn = (
      ctx: DroidSessionContext,
      turnId: TurnId,
      payload: TurnCompletedPayload,
    ) =>
      Effect.gen(function* () {
        if (ctx.openTurnId !== turnId) return;
        ctx.openTurnId = undefined;
        // A sub-agent Droid did not report on must not read as working, nor
        // extend the watchdog for the next turn.
        yield* closeSubagents(ctx, "turn-ended");
        if (payload.state !== "completed") yield* endRunningToolCalls(ctx);
        ctx.runningToolCalls.clear();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload,
        });
      });

    const markReady = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        ctx.activeTurnId = undefined;
        if (ctx.session.status !== "running" && ctx.session.status !== "connecting") return;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.session = { ...readySession, status: "ready", updatedAt: yield* nowIso };
      });

    /**
     * Ends the session. A turn still open ends too: cancelled for a requested
     * stop, failed with the reason when the process died.
     */
    const stopSessionInternal = (
      ctx: DroidSessionContext,
      exit?: { readonly errorMessage: string },
      openTurnWarning?: string,
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        for (const turnId of [ctx.activeTurnId, ctx.openTurnId]) {
          if (turnId !== undefined) ctx.interruptedTurnIds.add(turnId);
        }
        ctx.promptsInFlight = 0;
        yield* closeSubagents(ctx, "session-ended");
        yield* dropHeldFollowUp(ctx);
        if (ctx.openTurnId !== undefined) {
          if (openTurnWarning !== undefined)
            yield* offerNotice(ctx, ctx.openTurnId, openTurnWarning);
          yield* completeTurn(
            ctx,
            ctx.openTurnId,
            exit
              ? { state: "failed", errorMessage: exit.errorMessage }
              : { state: "cancelled", stopReason: "cancelled" },
          );
        }
        yield* markReady(ctx);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.idleWatchdogFiber) {
          yield* Fiber.interrupt(ctx.idleWatchdogFiber).pipe(Effect.ignore);
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
        releaseThreadLockIfUnused(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: exit
            ? { exitKind: "error", reason: exit.errorMessage, recoverable: true }
            : { exitKind: "graceful" },
        });
      });

    /** Droid's process exited: fail what was running and let the next message start fresh. */
    const handleProcessExit = (ctx: DroidSessionContext, error: EffectAcpErrors.AcpError) =>
      withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) return;
          // A Custom models change retired this process on purpose.
          if (ctx.acp.isConfigurationRetired?.() === true)
            return yield* stopSessionInternal(ctx, undefined, DROID_CONFIGURATION_RETIRED_MESSAGE);
          const errorMessage = redactCredentials(droidPromptFailureMessage(error));
          yield* Effect.logWarning("Droid process exited; ending its session.", {
            threadId: ctx.threadId,
            errorMessage,
          });
          yield* stopSessionInternal(ctx, { errorMessage });
        }),
      );

    // ── Idle watchdog ────────────────────────────────────────────────────
    // Force-fails turns whose child process is alive but silent. Any inbound
    // event resets the deadline; open sub-agents (`Task`, foreground or
    // background) extend the cap to a still-finite window because their
    // progress never crosses ACP, and a blocking `TaskOutput` gets at least the
    // wait Droid announced. Time spent waiting for the user's answer does not count.
    const idleCapMillis = (ctx: DroidSessionContext) => {
      const { open, announcedWaitMillis } = droidSubagentActivity(ctx.subagents);
      const cap =
        open > 0 || announcedWaitMillis === "unbounded"
          ? NESTED_TASK_TURN_IDLE_TIMEOUT_MILLIS
          : idleTimeoutMillis;
      // Never shorter than the wait Droid announced: its `TaskOutput` blocks in
      // silence for up to its own timeout, which is the ordinary window (10 min).
      return typeof announcedWaitMillis === "number"
        ? Math.max(cap, announcedWaitMillis + ANNOUNCED_WAIT_MARGIN_MILLIS)
        : cap;
    };

    const extendIdleDeadline = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        const nowMillis = yield* Clock.currentTimeMillis;
        yield* Ref.set(ctx.idleDeadlineRef, nowMillis + idleCapMillis(ctx));
      });

    const startIdleWatchdog = (ctx: DroidSessionContext) =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(watchdogTickMillis);
          if (ctx.stopped || ctx.activeTurnId === undefined) continue;
          if (ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0) {
            // Paused while the user decides; a full window follows the answer.
            yield* extendIdleDeadline(ctx);
            continue;
          }
          const nowMillis = yield* Clock.currentTimeMillis;
          const deadline = yield* Ref.get(ctx.idleDeadlineRef);
          if (nowMillis < deadline) continue;
          const stalledTurnId = ctx.activeTurnId;
          const window = formatIdleWindow(idleCapMillis(ctx));
          const { open: openSubagents, announcedWaitMillis } = droidSubagentActivity(ctx.subagents);
          const errorMessage =
            openSubagents > 0
              ? `Droid turn exceeded the idle timeout (${window}) while executing ${openSubagents} subagent task(s).`
              : announcedWaitMillis !== undefined
                ? `Droid turn exceeded the idle timeout (${window}) while waiting for a sub-agent.`
                : `Droid turn exceeded the idle timeout (${window}).`;
          yield* Effect.logWarning("Droid turn exceeded the idle watchdog; failing the turn.", {
            threadId: ctx.threadId,
            turnId: stalledTurnId,
            nestedTasks: openSubagents,
          });
          // The interrupt path tears the session scope down, which would
          // interrupt this watchdog fiber mid-cleanup (it is forked into that
          // same scope). Run it in a detached fiber so the force-settle and
          // teardown complete even though they kill this fiber's home scope.
          yield* Effect.forkDetach(
            interruptTurnInternal(ctx.threadId, stalledTurnId, { errorMessage }).pipe(
              Effect.ignore,
            ),
          );
        }
      });

    /**
     * Releases one prompt slot. Only the last slot of a turn settles it: the
     * session returns to ready and the turn ends with the latest prompt's
     * outcome (a steer-superseded prompt contributes none), after `warning`.
     */
    const settlePromptSlot = (
      ctx: DroidSessionContext,
      turnId: TurnId,
      outcome?: {
        readonly payload: TurnCompletedPayload;
        readonly superseded?: boolean;
        readonly warning?: string;
      },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) return false;
        ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
        if (outcome && !outcome.superseded) {
          ctx.pendingOutcome = {
            payload: outcome.payload,
            ...(outcome.warning ? { warning: outcome.warning } : {}),
          };
        }
        if (ctx.promptsInFlight > 0 || ctx.activeTurnId !== turnId) return false;
        const settled = ctx.pendingOutcome;
        ctx.pendingOutcome = undefined;
        yield* markReady(ctx);
        if (settled?.warning) yield* offerNotice(ctx, turnId, settled.warning);
        // A started turn always ends; one whose prompts all returned without an outcome was stopped.
        yield* completeTurn(
          ctx,
          turnId,
          settled?.payload ?? { state: "cancelled", stopReason: "cancelled" },
        );
        return settled !== undefined;
      });

    /**
     * Stop: phase 1 (no lock) marks the target so late prompt results and
     * queued follow-ups cannot resurrect it; phase 2 (thread lock) cancels,
     * takes what Droid still sends for the cancelled prompt, ends the turn
     * and tears the session down. Droid acknowledges cancel while nested
     * workers quiesce, so the session is never reused after a cancel — the
     * next message cold-starts from the resume cursor.
     */
    const interruptTurnInternal = (
      threadId: ThreadId,
      turnId: TurnId | undefined,
      options?: { readonly errorMessage?: string },
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) return;
        const current = ctx.activeTurnId ?? ctx.openTurnId;
        // A turn that already ended has nothing to stop.
        if (turnId !== undefined && current !== turnId) return;
        const target = turnId ?? current;
        if (target !== undefined) ctx.interruptedTurnIds.add(target);

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            if (ctx.stopped || sessions.get(threadId) !== ctx) return;
            // Another turn may have started while Stop waited: leave it running.
            const now = ctx.activeTurnId ?? ctx.openTurnId;
            if (target !== undefined && now !== undefined && now !== target) return;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            // Before the cancel: the prompt it ends would otherwise let the follow-up go.
            yield* dropHeldFollowUp(ctx);
            // After any prompt dispatch in progress, so the cancel reaches it. A
            // Stop keeps what Droid sends on its way out; a turn being failed
            // (Droid is silent) has nothing to wait for.
            yield* ctx.promptLifecycle.withPermit(
              options?.errorMessage === undefined
                ? ctx.acp.cancelAndAwaitPrompt(STOP_FLUSH_TIMEOUT)
                : Effect.ignore(ctx.acp.cancel),
            );
            ctx.promptsInFlight = 0;
            yield* closeSubagents(
              ctx,
              options?.errorMessage !== undefined ? "session-ended" : "stop",
            );
            // A turn starts when its first prompt is written. Before that there is
            // no turn to fail, so a failure's reason goes out with the session's end.
            const turnStarted = target !== undefined && ctx.openTurnId === target;
            if (target !== undefined) {
              yield* completeTurn(
                ctx,
                target,
                options?.errorMessage !== undefined
                  ? { state: "failed", errorMessage: options.errorMessage }
                  : { state: "cancelled", stopReason: "cancelled" },
              );
            }
            yield* markReady(ctx);
            yield* stopSessionInternal(
              ctx,
              options?.errorMessage !== undefined && !turnStarted
                ? { errorMessage: options.errorMessage }
                : undefined,
            );
          }),
        );
      });

    const startSession: DroidAdapterShape["startSession"] = (input) =>
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

          const cwd = path.resolve(input.cwd.trim());
          const droidModelSelection: ModelSelection | undefined =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            // Replacement start awaits the predecessor's scope fully closed
            // before spawning a new child.
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseDroidResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeAcpRuntime({
            droidSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            systemPrompt: buildScientAwareness(mcpSession?.capabilities),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "scient", version: "0.0.0" },
            clientCapabilities: { elicitation: { form: {} } },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "scient",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access" && !isDroidSpecApproval(params)) {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            yield* acp.handleElicitation((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/elicitation", params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingUserInputs.set(requestId, { answers: answersDeferred });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { questions: extractElicitationQuestions(params) },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/elicitation",
                      payload: params,
                    },
                  });
                  const resolvedAnswers = yield* Deferred.await(answersDeferred);
                  pendingUserInputs.delete(requestId);
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolvedAnswers },
                  });
                  const hasAnswers = Object.keys(resolvedAnswers).length > 0;
                  if (!hasAnswers) {
                    return { action: "cancel" as const };
                  }
                  const content = yield* decodeDroidElicitationAnswers(resolvedAnswers);
                  // The v1 `session/elicitation` envelope is added by the client
                  // from this flat action; the handler returns the action itself.
                  return {
                    action: "accept" as const,
                    content,
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.tapError((error) =>
              // Droid's text carries a one-time pairing code; report the fact, not the code.
              isDroidAuthenticationRequiredError(error)
                ? reportAuthenticationRejected("Droid reported that authentication is required")
                : Effect.void,
            ),
            Effect.mapError((error) => adapterError(input.threadId, "session/start", error)),
          );

          // Session-level configuration: autonomy mode first, then the
          // requested model/effort pair (model first — effort validity is
          // per-model). Every prompt re-checks autonomy before it is sent.
          const requestedStartEffort = requestedDroidEffortFromSelection(
            droidModelSelection?.options,
          );
          yield* applyDroidAutonomyMode({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            required: false,
          });
          const replacedDefault = yield* applyDroidModelAndEffort({
            runtime: acp,
            requestedModel: droidModelSelection?.model,
            requestedEffort: requestedStartEffort,
          }).pipe(
            Effect.mapError((cause) =>
              adapterError(input.threadId, "session/set_config_option", cause),
            ),
          );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(droidModelSelection?.model ? { model: droidModelSelection.model } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DROID_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: DroidSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            openTurnId: undefined,
            startedTurnId: undefined,
            interruptedTurnIds: new Set(),
            retryNoticeTurnId: undefined,
            pendingStop: undefined,
            promptsInFlight: 0,
            runningPrompts: 0,
            runningToolCalls: new Map(),
            endedToolCallIds: new Set(),
            heldFollowUp: undefined,
            promptEpoch: 0,
            discardBeforeEpoch: 0,
            promptLifecycle: yield* Semaphore.make(1),
            pendingOutcome: undefined,
            appliedModelSlug: droidModelSelection?.model,
            requestedEffortValue: requestedStartEffort,
            effortNotice: replacedDefault && droidReplacedDefaultNotice(replacedDefault),
            subagents: makeDroidSubagentTracker(),
            idleDeadlineRef: yield* Ref.make(Number.POSITIVE_INFINITY),
            idleWatchdogFiber: undefined,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                // Any inbound event is liveness; reset the watchdog clock.
                yield* extendIdleDeadline(ctx);
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ConnectionTerminated":
                    // Ending the session closes the scope this consumer runs in.
                    yield* Effect.forkDetach(handleProcessExit(ctx, event.error));
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveNotificationTurnId(ctx),
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveNotificationTurnId(ctx),
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(
                      ctx,
                      resolveNotificationTurnId(ctx),
                      yield* makeEventStamp(),
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated": {
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    const { toolCallId, status } = event.toolCall;
                    // Droid announces a call it cancelled again, untitled, and fails
                    // it again (any call on 0.213.0, sub-agents on 0.231.0): the row
                    // already says how the call ended.
                    if (ctx.endedToolCallIds.has(toolCallId)) return;
                    const turnId = resolveNotificationTurnId(ctx);
                    // A sub-agent is its own row (see `DroidSubagents`); a call that
                    // waits for one says which.
                    const subagent = observeDroidSubagentToolCall(
                      ctx.subagents,
                      event.toolCall,
                      turnId,
                    );
                    const row: RunningToolCallRow | undefined =
                      subagent.item === "none"
                        ? undefined
                        : subagent.item === "unchanged"
                          ? { turnId, toolCall: event.toolCall }
                          : { turnId, toolCall: subagent.item, itemType: "collab_agent_tool_call" };
                    if (status === "completed" || status === "failed") {
                      ctx.endedToolCallIds.add(toolCallId);
                      ctx.runningToolCalls.delete(toolCallId);
                    } else if (ctx.openTurnId !== undefined)
                      // Also one taken in after its prompt returned: its row is shown
                      // all the same, and the turn must end it. A later update never
                      // makes it the work of another prompt.
                      ctx.runningToolCalls.set(toolCallId, {
                        row,
                        live: ctx.runningToolCalls.get(toolCallId)?.live ?? ctx.runningPrompts > 0,
                      });
                    yield* offerSubagentEvents(ctx, subagent.events);
                    // The deadline was set before this call was known: a sub-agent or
                    // a wait that just began gets its own window from now.
                    yield* extendIdleDeadline(ctx);
                    yield* releaseHeldFollowUp(ctx);
                    if (row !== undefined) {
                      yield* offerRuntimeEvent(
                        makeAcpToolCallEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          ...row,
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                  }
                  case "ContentDelta":
                  case "ThoughtDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveNotificationTurnId(ctx),
                        ...(event._tag === "ContentDelta" && event.itemId
                          ? { itemId: event.itemId }
                          : {}),
                        ...(event._tag === "ThoughtDelta"
                          ? { streamKind: "reasoning_text" as const }
                          : {}),
                        // Droid prints an error it got as its own text. Each chunk
                        // is redacted on its own: a credential split across two
                        // chunks is not caught.
                        text: redactCredentials(event.text),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Droid runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber. `forkChild`
            // makes this a child of `startSession`, and Effect interrupts a
            // fiber's children when it completes, so the consumer died as soon
            // as `startSession` returned and every later notification was
            // dropped. The scope is created, stored on the context and closed
            // on teardown already; only the fork target was wrong.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          ctx.idleWatchdogFiber = yield* startIdleWatchdog(ctx).pipe(Effect.forkIn(ctx.scope));
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Droid ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    /**
     * Under the thread lock: applies configuration, builds the prompt and
     * starts the turn. A follow-up during a running turn (a steer) keeps the
     * turn id and its custom-model request budget. Stopped during
     * preparation, a new turn still starts and ends cancelled.
     */
    const prepareTurn = (input: Parameters<DroidAdapterShape["sendTurn"]>[0]) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        // Count this prompt immediately so a superseded in-flight prompt
        // resolving from here on does not settle the turn.
        ctx.promptsInFlight += 1;
        ctx.promptEpoch += 1;
        const promptEpoch = ctx.promptEpoch;
        // Bind the turn id before cooperative yields so Stop can find it.
        ctx.activeTurnId = turnId;
        if (steeringTurnId === undefined && ctx.pendingStop) {
          // Stopped while the thread was still starting this turn.
          ctx.pendingStop.turnId = turnId;
          ctx.pendingStop = undefined;
          ctx.interruptedTurnIds.add(turnId);
        }
        // The watchdog measures this turn's silence, not the idle time before it.
        yield* extendIdleDeadline(ctx);
        ctx.session = {
          ...ctx.session,
          status: steeringTurnId === undefined ? "connecting" : "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        return yield* Effect.gen(function* () {
          const turnModelSelection: ModelSelection | undefined =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const requestedModel = turnModelSelection?.model ?? ctx.session.model ?? undefined;
          const requestedEffort = turnModelSelection
            ? requestedDroidEffortFromSelection(turnModelSelection.options)
            : ctx.requestedEffortValue;

          // Reassert model configuration only when it changed: Droid's
          // async config updates make redundant writes pure latency.
          if (
            requestedModel !== ctx.appliedModelSlug ||
            requestedEffort !== ctx.requestedEffortValue
          ) {
            const replacedDefault = yield* applyDroidModelAndEffort({
              runtime: ctx.acp,
              requestedModel,
              requestedEffort,
            }).pipe(
              Effect.mapError((error) =>
                adapterError(input.threadId, "session/set_config_option", error),
              ),
            );
            ctx.appliedModelSlug = requestedModel;
            ctx.requestedEffortValue = requestedEffort;
            // The notice is about the selection the prompt runs with: this one
            // supersedes whatever an earlier application left to say.
            ctx.effortNotice = replacedDefault && droidReplacedDefaultNotice(replacedDefault);
            if (requestedModel !== undefined && requestedModel !== ctx.session.model) {
              ctx.session = {
                ...ctx.session,
                model: requestedModel,
                updatedAt: yield* nowIso,
              };
            }
          }
          // Validate inherited runtime state on every send, including unchanged selections.
          yield* validateDroidReasoningState(ctx.acp).pipe(
            Effect.mapError((error) =>
              adapterError(input.threadId, "session/set_config_option", error),
            ),
          );
          yield* applyDroidAutonomyMode({
            runtime: ctx.acp,
            runtimeMode: ctx.session.runtimeMode,
            interactionMode: input.interactionMode,
            required: true,
          });

          const text = input.input?.trim();
          if (
            input.attachments?.length &&
            ctx.session.model &&
            ctx.acp.getImageSupport?.(ctx.session.model) === false
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail:
                "This custom model is set up without image input. Turn on Image input in its advanced settings under Settings > Custom models, or pick a model that takes images.",
            });
          }
          const imagePromptParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              } satisfies EffectAcpSchema.ContentBlock;
            }),
          );
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...imagePromptParts,
          ];

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
            yield* Effect.yieldNow;
          }
          const result = {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
          if (ctx.interruptedTurnIds.has(turnId)) {
            // Stop won before anything reached Droid. A follow-up leaves its
            // turn to Stop; a new turn never starts (see `announceSentPrompt`).
            yield* settlePromptSlot(ctx, turnId, {
              payload: { state: "cancelled", stopReason: "cancelled" },
            });
            return { _tag: "Stopped" as const, result };
          }
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
            ctx.endedToolCallIds.clear();
          }
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            ...(requestedModel ? { model: requestedModel } : {}),
          };
          // Arm the watchdog for this turn; inbound events keep extending.
          yield* extendIdleDeadline(ctx);

          if (steeringTurnId === undefined) {
            // A new turn gets a new custom-model request budget; a steer keeps the running one.
            if (ctx.acp.beginTurn) yield* ctx.acp.beginTurn;
          } else {
            // The follow-up's result decides the turn, and any older follow-up
            // still waiting must not be sent.
            ctx.discardBeforeEpoch = promptEpoch;
          }

          const model = findSelectDroidConfigOption(yield* ctx.acp.getConfigOptions, {
            category: "model",
            id: "model",
          })?.currentValue;
          return {
            _tag: "Prepared" as const,
            ctx,
            promptParts,
            turnId,
            promptEpoch,
            steering: steeringTurnId !== undefined,
            model: typeof model === "string" ? model : undefined,
            announce: announceSentPrompt({
              ctx,
              turnId,
              requestedModel,
              stamps: [yield* makeEventStamp(), yield* makeEventStamp()],
            }),
          } satisfies PreparedPrompt;
        }).pipe(
          Effect.tapCause(() =>
            // Nothing was sent for this prompt; a new turn never started.
            settlePromptSlot(ctx, turnId),
          ),
        );
      });

    /**
     * A follow-up waits here while the running prompt has live work. A newer
     * follow-up takes its place; the thread is told once that a message waits
     * (`again`: this follow-up was let go and found new work at dispatch).
     */
    const holdFollowUp = (prepared: PreparedPrompt, again = false) =>
      Effect.gen(function* () {
        const { ctx } = prepared;
        // A turn being stopped holds nothing: its follow-up is never sent.
        if (!prepared.steering || ctx.interruptedTurnIds.has(prepared.turnId) || !hasLiveWork(ctx))
          return;
        const release = yield* Deferred.make<void>();
        const replaced = ctx.heldFollowUp;
        ctx.heldFollowUp = release;
        if (replaced) yield* Deferred.succeed(replaced, undefined);
        else if (!again) yield* offerNotice(ctx, prepared.turnId, DROID_HELD_FOLLOW_UP_NOTICE);
        yield* Deferred.await(release);
      });

    /**
     * Under the prompt lifecycle lock: a follow-up first stops the prompt still
     * running (Droid then sees it as interrupted, verified on 0.228.0 and
     * 0.229.0), then the prompt is dispatched. A Stop or a newer follow-up
     * that got here first means this prompt is never sent. Droid would also
     * run a second prompt without a cancel, but then answers both and
     * interleaves them. `busy`: work began between the follow-up being let go
     * and this lock, so nothing was cancelled or sent and it must wait again.
     */
    const dispatchPrompt = (prepared: PreparedPrompt) =>
      prepared.ctx.promptLifecycle.withPermit(
        Effect.gen(function* () {
          const { ctx } = prepared;
          const skipped = () =>
            ctx.stopped ||
            sessions.get(ctx.threadId) !== ctx ||
            prepared.promptEpoch < ctx.discardBeforeEpoch ||
            ctx.interruptedTurnIds.has(prepared.turnId);
          if (skipped()) return undefined;
          // What Droid already sent is taken in first: a step that began as the
          // last one ended must be seen here, not after the cancel, and what a
          // returned prompt said last must not count as this prompt's work.
          yield* ctx.acp.drainEvents;
          if (skipped()) return undefined;
          if (prepared.steering && ctx.runningPrompts > 0) {
            if (hasLiveWork(ctx)) return "busy" as const;
            // The follow-up replaces the running prompt: its open requests are moot.
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            yield* Effect.ignore(ctx.acp.cancel);
            if (skipped()) return undefined;
          }
          const dispatched = yield* Deferred.make<void>();
          // Registered is not sent: only the write of the request says Droid got it.
          const sent = yield* Deferred.make<void>();
          ctx.runningPrompts += 1;
          const fiber = yield* ctx.acp
            .prompt(
              { prompt: [...prepared.promptParts] },
              {
                dispatched,
                onSend: Deferred.succeed(sent, undefined).pipe(Effect.andThen(prepared.announce)),
              },
            )
            .pipe(
              Effect.exit,
              Effect.ensuring(promptReturned(ctx)),
              Effect.forkChild({ startImmediately: true }),
            );
          // Hold the lock until the runtime registered this prompt, so a later
          // cancel targets it. Fall through if the prompt fails before that.
          yield* Effect.raceFirst(
            Deferred.await(dispatched),
            Fiber.await(fiber).pipe(Effect.asVoid),
          );
          return { fiber, sent };
        }),
      );

    /** Once per turn, while it runs: every prompt of a turn watches the same budget. */
    const announceUpstreamRetry = (prepared: PreparedPrompt, status: number) =>
      Effect.gen(function* () {
        const { ctx, turnId } = prepared;
        if (ctx.stopped || ctx.activeTurnId !== turnId || ctx.retryNoticeTurnId === turnId) return;
        ctx.retryNoticeTurnId = turnId;
        yield* offerNotice(
          ctx,
          turnId,
          `The model endpoint answered HTTP ${status}${status === 429 ? " (rate limited)" : ""}. Droid is retrying it, which can take a few minutes.`,
        );
      });

    /** Under the thread lock, after the prompt RPC returned. */
    const settlePrompt = (
      prepared: PreparedPrompt,
      exit: Exit.Exit<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>,
    ) =>
      Effect.gen(function* () {
        const { ctx, turnId } = prepared;
        const ended = () =>
          ctx.stopped || sessions.get(ctx.threadId) !== ctx || ctx.interruptedTurnIds.has(turnId);
        if (ended()) return;
        // Keep settlement atomic with Stop and steering: Stop marks its
        // target before waiting for this lock, so it can still win while the
        // final events are drained.
        for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
          yield* Effect.yieldNow;
        }
        yield* ctx.acp.drainEvents;
        if (ended()) return;

        // A follow-up stopped this prompt; the follow-up's own result decides the turn.
        const superseded = prepared.promptEpoch < ctx.discardBeforeEpoch;
        // A Custom models change retired this process; the prompt ends cancelled.
        const retired = ctx.acp.isConfigurationRetired?.() === true;
        if (Exit.isSuccess(exit)) {
          appendPromptResultToTurn(ctx, turnId, prepared.promptParts, exit.value);
          const payload = droidPromptCompletion(exit.value.stopReason ?? null);
          // Scient ended a runaway custom-model loop; say why it stopped.
          const requestLimit = superseded ? undefined : ctx.acp.requestLimitBreach?.();
          const warning =
            requestLimit?.message ??
            (retired && payload.state === "cancelled"
              ? DROID_CONFIGURATION_RETIRED_MESSAGE
              : undefined);
          const settled = yield* settlePromptSlot(ctx, turnId, {
            payload,
            superseded,
            ...(warning ? { warning } : {}),
          });
          // Like a cancel, the prompt was stopped under Droid: never reuse that process.
          if (settled && requestLimit) yield* stopSessionInternal(ctx);
          return;
        }

        const error = Exit.findErrorOption(exit);
        const agentLevel = error._tag === "Some" && isAcpRequestError(error.value);
        if (error._tag === "None" || (!agentLevel && retired)) {
          // Interrupted without an error of its own, or its process retired: the turn cannot continue.
          yield* settlePromptSlot(ctx, turnId, {
            payload: { state: "cancelled", stopReason: "cancelled" },
            superseded,
            ...(retired ? { warning: DROID_CONFIGURATION_RETIRED_MESSAGE } : {}),
          });
          return;
        }
        const errorMessage = redactCredentials(droidPromptFailureMessage(error.value));
        yield* settlePromptSlot(ctx, turnId, {
          payload: { state: "failed", errorMessage },
          superseded,
        });
        if (agentLevel && isDroidAccountRejection(errorMessage)) {
          // Only a Factory-hosted model's 401 is about the Factory account; a
          // `custom:` model's is about its own key. A follow-up may have
          // switched models since, so use the one this prompt ran with.
          const model = prepared.model;
          if (model?.trim() && !model.startsWith("custom:"))
            yield* reportAuthenticationRejected(errorMessage);
        }
        // An agent-level error leaves Droid usable for a retry; anything else
        // means the process is gone or unusable.
        if (!agentLevel) yield* stopSessionInternal(ctx, { errorMessage });
      });

    /**
     * Resolves when the turn has settled. Once a turn's prompt reached Droid,
     * its outcome is its terminal event: the send itself succeeds, including
     * when stopped. A send whose prompt never reached Droid (stopped first,
     * superseded, or Droid gone before the prompt was registered) ends
     * interrupted: callers must not treat it as delivered (a fork's context
     * handoff stays pending), and interruption is not reported as a failure.
     */
    const sendTurn: DroidAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const entered = sessions.get(input.threadId);
        // A Custom models change retired the process, not a Stop: the user must
        // learn the message was not sent rather than see nothing happen.
        const notSent = (
          ctx: DroidSessionContext | undefined,
        ): Effect.Effect<never, ProviderAdapterRequestError> =>
          ctx?.acp.isConfigurationRetired?.() === true
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: DROID_RETIRED_SEND_MESSAGE,
                }),
              )
            : Effect.interrupt;
        const prepared = yield* withThreadLock(input.threadId, prepareTurn(input)).pipe(
          // Stop (or Droid exiting) ended the session while this send waited: nothing was sent.
          Effect.catchTag(
            "ProviderAdapterSessionNotFoundError",
            (error): Effect.Effect<never, ProviderAdapterError> =>
              entered?.stopped ? notSent(entered) : Effect.fail(error),
          ),
        );
        if (prepared._tag === "Stopped") return yield* Effect.interrupt;
        const result = {
          threadId: input.threadId,
          turnId: prepared.turnId,
          resumeCursor: prepared.ctx.session.resumeCursor,
        };
        const delivered = yield* Effect.gen(function* () {
          yield* holdFollowUp(prepared);
          let started = yield* dispatchPrompt(prepared);
          while (started === "busy") {
            yield* holdFollowUp(prepared, true);
            started = yield* dispatchPrompt(prepared);
          }
          if (started === undefined) {
            // Superseded by a newer follow-up or ended by Stop: this prompt was never sent.
            yield* withThreadLock(
              input.threadId,
              prepared.ctx.interruptedTurnIds.has(prepared.turnId)
                ? Effect.void
                : settlePromptSlot(prepared.ctx, prepared.turnId),
            );
            return false;
          }
          // Droid retries a custom model's 429/5xx answers for minutes without a word.
          const retryNotice = prepared.ctx.acp.upstreamRetrying
            ? yield* prepared.ctx.acp.upstreamRetrying.pipe(
                Effect.flatMap((status) => announceUpstreamRetry(prepared, status)),
                Effect.forkChild,
              )
            : undefined;
          const exit = yield* Fiber.join(started.fiber);
          if (retryNotice) yield* Fiber.interrupt(retryNotice);
          if (Exit.isSuccess(exit))
            yield* (
              options?.testHooks?.afterPromptRpcSucceeded?.(input.threadId, prepared.turnId) ??
                Effect.void
            );
          yield* withThreadLock(input.threadId, settlePrompt(prepared, exit));
          return yield* Deferred.isDone(started.sent);
        }).pipe(
          Effect.onInterrupt(() =>
            withThreadLock(
              input.threadId,
              settlePromptSlot(prepared.ctx, prepared.turnId, {
                payload: { state: "cancelled", stopReason: "cancelled" },
              }),
            ),
          ),
        );
        // The session this send entered is the one its prompt was prepared on.
        if (!delivered) return yield* notSent(entered);
        return result;
      });

    const interruptTurn: DroidAdapterShape["interruptTurn"] = (threadId, turnId) =>
      interruptTurnInternal(threadId, turnId);

    /**
     * A Stop handle bound to one turn: the turn running when it was captured,
     * else the one running when it interrupts, else the turn the thread is
     * still starting (which then ends at once). It confirms and tears down
     * only while that turn is current, never a turn that started after it.
     */
    const captureTurnStop: NonNullable<DroidAdapterShape["captureTurnStop"]> = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const current = () => ctx.activeTurnId ?? ctx.openTurnId;
        let target = current();
        let pending: { turnId: TurnId | undefined } | undefined;
        const targetActive = () => {
          if (sessions.get(threadId) !== ctx || ctx.stopped) return false;
          const turnId = target ?? pending?.turnId;
          if (turnId !== undefined) return current() === turnId;
          return pending !== undefined && ctx.pendingStop === pending;
        };
        return {
          interrupt: Effect.suspend(() => {
            if (sessions.get(threadId) !== ctx || ctx.stopped) return Effect.void;
            target ??= current();
            if (target !== undefined) return interruptTurnInternal(threadId, target);
            // The thread is starting a turn whose send has not bound it here yet.
            pending = { turnId: undefined };
            ctx.pendingStop = pending;
            return Effect.void;
          }),
          // Ended once its turn is no longer current: done, or its process gone.
          confirm: Effect.sync(() => (targetActive() ? ("active" as const) : ("ended" as const))),
          stop: (onStopped?: Effect.Effect<void>) =>
            withThreadLock(
              threadId,
              Effect.gen(function* () {
                if (!targetActive()) return false;
                yield* stopSessionInternal(ctx);
                if (onStopped) yield* onStopped;
                return true;
              }),
            ),
        };
      });

    const respondToRequest: DroidAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: DroidAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: DroidAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: DroidAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
          method: "thread/rollback",
          detail: "Droid ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: DroidAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: DroidAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values()).flatMap((c) =>
          c.acp.isConfigurationRetired?.() === true ||
          (c.promptsInFlight === 0 && c.acp.isConfigurationCurrent?.() === false)
            ? []
            : [{ ...c.session }],
        ),
      );

    const hasSession: DroidAdapterShape["hasSession"] = (threadId) =>
      Effect.gen(function* () {
        const c = sessions.get(threadId);
        if (!c || c.stopped) return false;
        if (c.acp.checkConfiguration) yield* c.acp.checkConfiguration().pipe(Effect.ignore);
        return (
          c.acp.isConfigurationRetired?.() !== true &&
          (c.promptsInFlight > 0 || c.acp.isConfigurationCurrent?.() !== false)
        );
      });

    const getModelContextWindow: NonNullable<DroidAdapterShape["getModelContextWindow"]> = ({
      threadId,
      modelSelection,
    }) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped || modelSelection.instanceId !== boundInstanceId) return undefined;
        // Only Scient custom models have known limits; native models stay unknown.
        return ctx.acp.getContextWindow?.(modelSelection.model);
      });

    const stopAll: DroidAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        mcpSessionInjection: true,
        supportsConversationRollback: false,
      },
      startSession,
      getModelContextWindow,
      sendTurn,
      interruptTurn,
      captureTurnStop,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DroidAdapterShape;
  });
}

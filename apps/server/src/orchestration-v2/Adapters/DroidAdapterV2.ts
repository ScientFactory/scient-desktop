import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { ProviderDriverKind, type DroidSettings } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import {
  applyDroidModelAndEffort,
  confirmDroidAutonomy,
  findSelectDroidConfigOption,
  makeDroidCredentialRedactor,
  resolveDroidAutonomyModeId,
  validateDroidReasoningState,
  type DroidAcpRuntime,
  type DroidAcpRuntimeFactory,
} from "../../provider/acp/DroidAcpSupport.ts";
import {
  droidSubagentActivity,
  makeDroidSubagentTracker,
  observeDroidSubagentToolCall,
} from "../../provider/droid/DroidSubagents.ts";
import { acpPermissionDisposition } from "../../provider/acp/AcpClientPolicy.ts";
import { isDroidAuthenticationRequiredError } from "../../provider/Layers/DroidProvider.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2Options,
} from "./AcpAdapterV2.ts";

export interface DroidAdapterV2Options extends Omit<AcpAdapterV2Options, "flavor"> {
  readonly settings: DroidSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly sensitiveEnvironmentValues: ReadonlyArray<string>;
  readonly makeRuntime: DroidAcpRuntimeFactory;
  readonly childProcessSpawner: Parameters<DroidAcpRuntimeFactory>[0]["childProcessSpawner"];
  readonly onAuthenticationRejected: (message: string) => Effect.Effect<void>;
}
const DEFAULT_IDLE_MILLIS = 600_000;
const TASK_IDLE_MILLIS = 3_600_000;
const ANNOUNCED_WAIT_MARGIN_MILLIS = 60_000;

interface DroidPromptWatch {
  readonly tasks: ReturnType<typeof makeDroidSubagentTracker>;
  deadline: number;
  decisions: number;
}
function idleCap(watch: DroidPromptWatch, idleMillis: number): number {
  const activity = droidSubagentActivity(watch.tasks);
  const cap =
    activity.open > 0 || activity.announcedWaitMillis === "unbounded"
      ? TASK_IDLE_MILLIS
      : idleMillis;
  return typeof activity.announcedWaitMillis === "number"
    ? Math.max(cap, activity.announcedWaitMillis + ANNOUNCED_WAIT_MARGIN_MILLIS)
    : cap;
}
function idleMessage(watch: DroidPromptWatch, idleMillis: number): string {
  const millis = idleCap(watch, idleMillis);
  const window =
    millis % 60_000 === 0
      ? `${millis / 60_000}m`
      : millis % 1_000 === 0
        ? `${millis / 1_000}s`
        : `${millis}ms`;
  const activity = droidSubagentActivity(watch.tasks);
  const suffix =
    activity.open > 0
      ? ` while executing ${activity.open} subagent task(s)`
      : activity.announcedWaitMillis !== undefined
        ? " while waiting for a sub-agent"
        : "";
  return `Droid turn exceeded the idle timeout (${window})${suffix}.`;
}
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function makeDroidAdapterV2(options: DroidAdapterV2Options) {
  const runtimes = new WeakMap<object, DroidAcpRuntime>();
  const redact = makeDroidCredentialRedactor({
    environment: options.environment,
    sensitiveValues: options.sensitiveEnvironmentValues,
  });
  const flavor: AcpAdapterV2Flavor = {
    driver: ProviderDriverKind.make("droid"),
    runtimeHarness: "Droid",
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
        supportsRuntimeModeSwitchInSession: true,
      },
      tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
    },
    supportsImagePrompts: true,
    supportsCompaction: true,
    applyRuntimePolicy: (runtime, policy) =>
      confirmDroidAutonomy(
        runtime,
        policy.interactionMode === "plan"
          ? "spec"
          : resolveDroidAutonomyModeId(
              policy.approvalPolicy === undefined && policy.sandboxPolicy === undefined
                ? policy.runtimeMode
                : "approval-required",
            ),
      ),
    permissionDisposition: (policy, request) =>
      request.toolCall.title?.trim() === "Approve Spec" ||
      (typeof request.toolCall.rawInput === "object" &&
        request.toolCall.rawInput !== null &&
        "plan" in request.toolCall.rawInput &&
        typeof request.toolCall.rawInput.plan === "string" &&
        request.toolCall.kind === "other")
        ? "ask"
        : acpPermissionDisposition(policy, request),
    makeRuntime: (input) =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const runtime = yield* options.makeRuntime({
          ...input,
          droidSettings: options.settings,
          systemPrompt: input.scientAwareness ?? buildScientAwareness(),
          environment: { ...options.environment, ...input.processEnvironment },
          childProcessSpawner: options.childProcessSpawner,
          ownDetachedProcessGroup: true,
          ownDescendantProcessGroups: platform === "linux",
          processGroupPlatform: platform,
        });
        const configuredIdle = Number(options.environment.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS);
        const idleMillis =
          Number.isFinite(configuredIdle) && configuredIdle > 0
            ? configuredIdle
            : DEFAULT_IDLE_MILLIS;
        const tickMillis = Math.min(15_000, Math.max(25, Math.floor(idleMillis / 4)));
        // The token belongs to this runtime's exact prompt, never a global session timer.
        let currentWatch: DroidPromptWatch | undefined;
        let nativeSessionId: string | undefined;
        const activity = Effect.gen(function* () {
          const watch = currentWatch;
          if (watch === undefined) return;
          const now = yield* Clock.currentTimeMillis;
          if (currentWatch === watch) watch.deadline = now + idleCap(watch, idleMillis);
        });
        const duringDecision = <A, E, R>(
          sessionId: string | undefined,
          effect: Effect.Effect<A, E, R>,
        ) =>
          Effect.suspend(() => {
            const watch =
              sessionId !== undefined && sessionId === nativeSessionId ? currentWatch : undefined;
            if (watch === undefined) return effect;
            watch.decisions += 1;
            return effect.pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  watch.decisions -= 1;
                  if (currentWatch === watch) yield* activity;
                }),
              ),
            );
          });
        const wrapped: DroidAcpRuntime = {
          ...runtime,
          getEvents: () =>
            runtime.getEvents().pipe(
              Stream.tap((event) =>
                Effect.gen(function* () {
                  if (event._tag === "EventStreamBarrier" || event._tag === "ConnectionTerminated")
                    return;
                  const watch = currentWatch;
                  if (watch === undefined) return;
                  if (event._tag === "ToolCallUpdated")
                    observeDroidSubagentToolCall(watch.tasks, event.toolCall, undefined);
                  yield* activity;
                }),
              ),
            ),
          handleRequestPermission: (handler) =>
            runtime.handleRequestPermission((request, context) =>
              duringDecision(
                request.sessionId,
                Effect.suspend(() => handler(request, context)),
              ),
            ),
          handleElicitation: (handler) =>
            runtime.handleElicitation((request, context) =>
              duringDecision(
                nativeSessionId,
                Effect.suspend(() => handler(request, context)),
              ),
            ),
          start: () =>
            runtime.start().pipe(
              Effect.tap((started) =>
                Effect.sync(() => {
                  nativeSessionId = started.sessionId;
                }),
              ),
              Effect.tapError((error) =>
                isDroidAuthenticationRequiredError(error)
                  ? options.onAuthenticationRejected(
                      "Droid reported that authentication is required",
                    )
                  : Effect.void,
              ),
            ),
          prompt: (request, dispatch) =>
            Effect.gen(function* () {
              if (runtime.checkConfiguration) yield* runtime.checkConfiguration();
              yield* validateDroidReasoningState(runtime);
              const model = findSelectDroidConfigOption(yield* runtime.getConfigOptions, {
                category: "model",
                id: "model",
              })?.currentValue;
              if (
                typeof model === "string" &&
                runtime.getImageSupport?.(model) === false &&
                request.prompt.some((block) => block.type === "image")
              )
                return yield* new EffectAcpErrors.AcpRequestError({
                  code: -32602,
                  errorMessage: "The selected Droid model does not support image prompts.",
                });
              const watch: DroidPromptWatch = {
                tasks: makeDroidSubagentTracker(),
                decisions: 0,
                deadline: (yield* Clock.currentTimeMillis) + idleMillis,
              };
              currentWatch = watch;
              const result = yield* Effect.gen(function* () {
                const outcome = yield* Effect.raceFirst(
                  runtime.prompt(request, dispatch).pipe(
                    Effect.map((response) => ({
                      _tag: "Completed" as const,
                      response,
                    })),
                  ),
                  Effect.gen(function* () {
                    while (true) {
                      yield* Effect.sleep(tickMillis);
                      if (currentWatch !== watch) return yield* Effect.never;
                      const now = yield* Clock.currentTimeMillis;
                      if (watch.decisions > 0) {
                        watch.deadline = now + idleCap(watch, idleMillis);
                        continue;
                      }
                      if (now >= watch.deadline)
                        return { _tag: "Idle" as const, message: idleMessage(watch, idleMillis) };
                    }
                  }),
                );
                if (outcome._tag === "Completed") return outcome.response;
                // The race retires the exact prompt first. Flush cancellation, then
                // terminate its owned native process group; sibling instances are untouched.
                return yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* runtime.cancelAndAwaitPrompt("2 seconds");
                    if (runtime.terminateProcessGroup)
                      yield* runtime.terminateProcessGroup.pipe(Effect.ignoreCause({ log: true }));
                    return yield* new EffectAcpErrors.AcpRequestError({
                      code: -32603,
                      errorMessage: outcome.message,
                    });
                  }),
                );
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (currentWatch === watch) {
                      currentWatch = undefined;
                    }
                  }),
                ),
              );
              if (result.stopReason === "refusal")
                return yield* new EffectAcpErrors.AcpRequestError({
                  code: -32603,
                  errorMessage: "Droid ended the turn because its agent reported an error.",
                });
              return result;
            }).pipe(
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  const model = findSelectDroidConfigOption(yield* runtime.getConfigOptions, {
                    category: "model",
                    id: "model",
                  })?.currentValue;
                  const detail =
                    isAcpRequestError(error) && typeof error.data === "string"
                      ? error.data.trim()
                      : error.message;
                  if (
                    typeof model === "string" &&
                    model.trim() &&
                    !model.startsWith("custom:") &&
                    (/^401\b/.test(detail) || /\bauthentication required\b/i.test(detail))
                  )
                    yield* options.onAuthenticationRejected(redact(detail));
                }),
              ),
            ),
        };
        runtimes.set(wrapped, runtime);
        return wrapped;
      }),
    beforeTurnStart: (runtime, policy) =>
      Effect.gen(function* () {
        const droid = runtimes.get(runtime);
        if (droid?.checkConfiguration) yield* droid.checkConfiguration();
        yield* confirmDroidAutonomy(
          runtime,
          policy.interactionMode === "plan"
            ? "spec"
            : resolveDroidAutonomyModeId(
                policy.approvalPolicy === undefined && policy.sandboxPolicy === undefined
                  ? policy.runtimeMode
                  : "approval-required",
              ),
        );
        if (droid?.beginTurn) yield* droid.beginTurn;
      }),
    applyModelSelection: ({ runtime, modelSelection }) =>
      Effect.gen(function* () {
        const droid = runtimes.get(runtime) ?? runtime;
        yield* applyDroidModelAndEffort({
          runtime: droid,
          requestedModel: modelSelection.model,
          requestedEffort: getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
        });
        const model = findSelectDroidConfigOption(yield* runtime.getConfigOptions, {
          category: "model",
          id: "model",
        })?.currentValue;
        return typeof model === "string" ? model : undefined;
      }),
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        message: redact(
          isAcpRequestError(cause) && typeof cause.data === "string" && cause.data.trim()
            ? cause.data.trim()
            : String(cause),
        ),
        class: "provider_error",
      }),
  };
  return makeAcpAdapterV2({ ...options, flavor });
}

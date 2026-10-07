import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  XAiPromptFailureText,
  isXAiTaskCompletedWakeNotification,
  xAiRateLimitedErrorCode,
} from "../../provider/acp/XAiAcpExtension.ts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  defaultInstanceIdForDriver,
  GrokSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ServerConfig from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  currentGrokReasoningEffortFromSessionSetup,
  GROK_DEFAULT_MODEL_SLUG,
  grokApprovalOptions,
  makeGrokAcpRuntime,
  normalizeGrokReasoningEffort,
  resolveGrokAcpBaseModelId,
} from "../../provider/acp/GrokAcpSupport.ts";
import {
  extractGrokPlanMarkdownFromToolCallData,
  extractXAiAcpBackgroundToolMutation,
  extractXAiAcpSubagentEndNotice,
  extractXAiAcpSubagentUpdate,
  extractXAiAskUserQuestionIdentity,
  extractXAiAskUserQuestions,
  extractXAiBackgroundTaskCompletion,
  extractXAiKilledBackgroundTasks,
  extractXAiMonitorTaskId,
  isXAiPersistentMonitor,
  extractXAiExitPlanMarkdown,
  registerXAiSubagentFinished,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  makeXAiExitPlanModeCapturedResponse,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
  XAiAskUserQuestionRequest,
  XAiExitPlanModeRequest,
} from "../../provider/acp/XAiAcpExtension.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { acpPermissionDisposition } from "../../provider/acp/AcpClientPolicy.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const GROK_PROVIDER = ProviderDriverKind.make("grok");
const GROK_DRIVER_KIND = GROK_PROVIDER;
export const GROK_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(GROK_DRIVER_KIND);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const DEFAULT_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({});

export const GrokProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canForkThread: false,
    canForkFromTurn: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface GrokAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: GrokSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly hostPlatform: NodeJS.Platform;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

const registerGrokAcpExtensions: NonNullable<AcpAdapterV2Flavor["registerExtensions"]> = ({
  runtime,
  requestUserInput,
  applyBackgroundTaskMutation,
  finishSubagent,
  captureProposedPlan,
  lastProposedPlanMarkdown,
}) =>
  registerXAiBackgroundTaskTracking(runtime, applyBackgroundTaskMutation).pipe(
    Effect.andThen(registerXAiSubagentFinished(runtime, finishSubagent)),
    Effect.andThen(registerGrokAskUserQuestionExtensions({ runtime, requestUserInput })),
    Effect.andThen(
      registerGrokExitPlanModeExtensions({
        runtime,
        captureProposedPlan,
        lastProposedPlanMarkdown,
      }),
    ),
  );

/**
 * Grok intercepts exit_plan_mode and reverse-requests client approval. Capture
 * the plan into T3's proposed-plan card and abandon the native gate so the
 * turn does not hang (#8358; mirrors the Claude ExitPlanMode pattern). Plan
 * content preference: the request payload, then the plan.md contents sniffed
 * from tool calls this turn, then the empty-state placeholder.
 */
const registerGrokExitPlanModeExtensions = ({
  runtime,
  captureProposedPlan,
  lastProposedPlanMarkdown,
}: Pick<
  AcpAdapterV2ExtensionContext,
  "runtime" | "captureProposedPlan" | "lastProposedPlanMarkdown"
>) =>
  Effect.forEach(
    ["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"] as const,
    (method) =>
      runtime.handleExtRequest(method, XAiExitPlanModeRequest, (params) =>
        Effect.gen(function* () {
          const fallback = yield* lastProposedPlanMarkdown;
          yield* captureProposedPlan({
            planMarkdown: extractXAiExitPlanMarkdown(params, fallback),
          });
          return makeXAiExitPlanModeCapturedResponse();
        }),
      ),
    { discard: true },
  );

const registerGrokAskUserQuestionExtensions = ({
  runtime,
  requestUserInput,
}: Pick<AcpAdapterV2ExtensionContext, "runtime" | "requestUserInput">) =>
  Effect.forEach(
    ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
    (method) =>
      runtime.handleExtRequest(method, XAiAskUserQuestionRequest, (params, requestContext) => {
        const identity = extractXAiAskUserQuestionIdentity(params);
        const questions = extractXAiAskUserQuestions(params).map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: [...question.options],
        }));
        return requestUserInput(
          {
            nativeItemId: `${identity.sessionId}:xai-question:${identity.toolCallId}`,
            nativeRequestId: identity.toolCallId,
            questions,
          },
          requestContext,
        ).pipe(
          Effect.flatMap(({ acknowledgeNativeResponse, answers }) =>
            Effect.succeed(
              answers === null
                ? makeXAiAskUserQuestionCancelledResponse()
                : makeXAiAskUserQuestionResponse(params, answers),
            ).pipe(Effect.tap(() => acknowledgeNativeResponse)),
          ),
        );
      }),
    { discard: true },
  );

/**
 * Grok's permission mode is fixed at launch. Explicit approval or sandbox
 * overrides launch it asking, so every mutating prompt reaches T3's policy
 * check instead of being bypassed by always-approve or Grok's auto classifier.
 */
export function grokLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

export function makeGrokAcpAdapterFlavor(options: GrokAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: GROK_PROVIDER,
    runtimeHarness: "Grok",
    capabilities: GrokProviderCapabilitiesV2,
    interruptPromptOnCancel: false,
    // User Stop (requestRuntimeRestart) still hard-kills the process group and
    // respawns so existing background tasks stop too. Older 0.2.x builds could
    // detach a cancelled foreground command (E3 harness 2026-07-18); current
    // source kills foreground work but intentionally preserves already-
    // backgrounded tasks. Non-Stop interrupts (mid-prompt steering,
    // restart_active) omit requestRuntimeRestart and stay soft: session/cancel
    // carries cancelTrigger=ctrl_c, the session survives, and background work
    // remains available to the replacement turn.
    restartRuntimeAfterInterrupt: true,
    terminateRuntimeProcessGroupOnInterrupt: true,
    // Steering restarts on a settled turn additionally skip session/cancel so
    // fire-and-forget subagents survive the steer (E1 harness confirmed the
    // Grok CLI accepts a concurrent session/prompt in that state).
    preserveRuntimeOnSettledInterrupt: true,
    // Grok ACP initialize reports promptCapabilities.image:false but the agent
    // still accepts image content blocks (verified with real screenshots).
    supportsImagePrompts: true,
    supportsCompaction: true,
    resolveModelId: (selection) => resolveGrokAcpBaseModelId(selection.model),
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      Effect.gen(function* () {
        const generation = yield* runtime.getProtocolGeneration;
        const requestedModelId = resolveGrokAcpBaseModelId(modelSelection.model);
        const requestedReasoningEffort = getModelSelectionStringOptionValue(
          modelSelection,
          "reasoningEffort",
        );
        if (
          requestedReasoningEffort !== undefined &&
          normalizeGrokReasoningEffort(requestedReasoningEffort) === undefined
        ) {
          return yield* EffectAcpErrors.AcpRequestError.invalidParams(
            "Grok cannot apply an invalid reasoning effort.",
          );
        }
        if (generation === 1) {
          const currentModelId = currentGrokModelIdFromSessionSetup(startResult.sessionSetupResult);
          if (
            requestedReasoningEffort !== undefined &&
            requestedModelId === GROK_DEFAULT_MODEL_SLUG &&
            currentModelId === undefined
          ) {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              "Grok has not advertised a model for the requested reasoning effort.",
            );
          }
          return yield* applyGrokAcpModelSelection({
            runtime,
            currentModelId,
            currentReasoningEffort: currentGrokReasoningEffortFromSessionSetup(
              startResult.sessionSetupResult,
            ),
            requestedModelId,
            requestedReasoningEffort,
            mapError: (cause) => cause,
          });
        }
        if (generation !== 2) {
          return yield* EffectAcpErrors.AcpRequestError.invalidParams(
            "Grok has not negotiated an ACP wire generation.",
          );
        }
        const modelOption = (yield* runtime.getConfigOptions).find(
          (option) => option.category === "model",
        );
        if (requestedModelId !== GROK_DEFAULT_MODEL_SLUG) {
          if (modelOption?.type !== "select") {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              "Grok does not advertise a model selection option.",
            );
          }
          if (modelOption.currentValue !== requestedModelId)
            yield* runtime.setConfigOption(modelOption.id, requestedModelId);
          const applied = (yield* runtime.getConfigOptions).find(
            (option) => option.id === modelOption.id,
          )?.currentValue;
          if (applied !== requestedModelId) {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              "Grok did not confirm the requested model.",
            );
          }
        }
        if (requestedReasoningEffort !== undefined) {
          const effort = normalizeGrokReasoningEffort(requestedReasoningEffort);
          const effortOption = (yield* runtime.getConfigOptions).find(
            (option) =>
              option.category === "thought_level" ||
              option.id === "reasoningEffort" ||
              option.id === "reasoning_effort",
          );
          if (effort === undefined || effortOption?.type !== "select") {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              "Grok does not advertise the requested reasoning effort.",
            );
          }
          if (effortOption.currentValue !== effort)
            yield* runtime.setConfigOption(effortOption.id, effort);
          const applied = (yield* runtime.getConfigOptions).find(
            (option) => option.id === effortOption.id,
          )?.currentValue;
          if (applied !== effort) {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              "Grok did not confirm the requested reasoning effort.",
            );
          }
        }
        const applied = (yield* runtime.getConfigOptions).find(
          (option) => option.category === "model",
        )?.currentValue;
        return typeof applied === "string" ? applied : undefined;
      }),
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, ...input }) =>
        makeGrokAcpRuntime({
          ...input,
          rules: input.scientAwareness ?? buildScientAwareness(),
          configOptionTransport: "request-confirmed",
          interruptPromptOnCancel: input.interruptPromptOnCancel ?? false,
          grokSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
          runtimeMode: grokLaunchRuntimeMode(runtimePolicy),
        })),
    // In its Auto mode Grok decides routine actions itself and only asks about
    // what its classifier blocked, so every prompt it sends goes to the user.
    permissionDisposition: (policy, request) =>
      grokLaunchRuntimeMode(policy) === "auto" ? "ask" : acpPermissionDisposition(policy, request),
    approvalOptions: grokApprovalOptions,
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? {
              // Grok's own failure text rides on the cause; makeProviderFailure
              // redacts and bounds it before it reaches the user.
              message:
                cause.cause instanceof XAiPromptFailureText
                  ? cause.cause.message
                  : cause.errorMessage,
              code: String(cause.code),
              class: cause.code === xAiRateLimitedErrorCode ? "usage_limit" : "provider_error",
            }
          : { class: "provider_error" }),
      }),
    registerExtensions: registerGrokAcpExtensions,
    extractSubagentUpdate: extractXAiAcpSubagentUpdate,
    extractSubagentEndNotice: extractXAiAcpSubagentEndNotice,
    normalizeToolCall: normalizeXAiAcpToolCallState,
    // Show the plan while Grok is still writing it: plan.md writes under the
    // Grok session dir surface as the proposed-plan card before exit (#8358).
    extractProposedPlanMarkdown: (toolCall) =>
      extractGrokPlanMarkdownFromToolCallData(toolCall.data, {
        platform: options.hostPlatform,
        environment: options.environment,
      }),
    extractBackgroundTaskId: extractXAiMonitorTaskId,
    extractBackgroundToolMutation: extractXAiAcpBackgroundToolMutation,
    extractBackgroundTaskCompletion: (toolCall) => [
      ...extractXAiBackgroundTaskCompletion(toolCall),
      ...extractXAiKilledBackgroundTasks(toolCall),
    ],
    isPersistentBackgroundTool: isXAiPersistentMonitor,
    isProviderWakeNotification: isXAiTaskCompletedWakeNotification,
    deferFinalizeForBackgroundWork: true,
    enablePostSettleContinuation: true,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export function makeGrokAdapterV2(options: GrokAdapterV2Options) {
  const flavor = makeGrokAcpAdapterFlavor(options);
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
}

export type GrokAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const GrokAdapterV2Driver: ProviderAdapterDriver<GrokSettings, GrokAdapterV2DriverEnv> = {
  driverKind: GROK_DRIVER_KIND,
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => DEFAULT_GROK_SETTINGS,
  create: Effect.fn("GrokAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<GrokSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const hostPlatform = yield* HostProcessPlatform;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeGrokAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        hostPlatform,
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: GROK_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: GROK_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Grok ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};

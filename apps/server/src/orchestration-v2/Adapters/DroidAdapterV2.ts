import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { ProviderDriverKind, type DroidSettings } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
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
        const wrapped: DroidAcpRuntime = {
          ...runtime,
          start: () =>
            runtime
              .start()
              .pipe(
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
              const result = yield* runtime.prompt(request, dispatch);
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

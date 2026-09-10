import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { preferredReasoningLevel } from "@t3tools/shared/model";

import type { PiRpcClient, PiRpcError } from "./PiRpcClient.ts";
import { PiThinkingLevel } from "./PiRpcSchema.ts";

export class PiModelSelectionError extends Schema.TaggedError<PiModelSelectionError>()(
  "PiModelSelectionError",
  {
    kind: Schema.Literals(["validation", "request"]),
    command: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeThinking = Schema.decodeUnknownEffect(PiThinkingLevel);
const rpc = <A>(command: string, effect: Effect.Effect<A, PiRpcError>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new PiModelSelectionError({
          kind: "request",
          command,
          detail: "detail" in cause ? cause.detail : `Pi ${command} failed.`,
          cause,
        }),
    ),
  );

/** Older callers can omit effort; fresh sessions use the same default policy as the composer. */
export const applyPiModelSelection = Effect.fn("applyPiModelSelection")(function* (
  client: Pick<PiRpcClient, "setModel" | "getThinkingLevels" | "setThinkingLevel" | "getState">,
  selected: { readonly provider: string; readonly modelId: string },
  thinking: string | undefined,
  context: {
    readonly messageCount?: number | undefined;
  } = {},
) {
  let level =
    thinking === undefined || thinking === "default"
      ? undefined
      : yield* decodeThinking(thinking).pipe(
          Effect.mapError(
            (cause) =>
              new PiModelSelectionError({
                kind: "validation",
                command: "set_thinking_level",
                detail: "Invalid Pi thinking level.",
                cause,
              }),
          ),
        );
  const model = yield* rpc("set_model", client.setModel(selected.provider, selected.modelId));
  if (model.provider !== selected.provider || model.id !== selected.modelId)
    return yield* new PiModelSelectionError({
      kind: "request",
      command: "set_model",
      detail: "Pi did not apply the requested model.",
    });
  const metadata = model.reasoningMetadata;
  const defaultLevel =
    metadata?.status === "known" && metadata.supported === true && metadata.levels.length > 0
      ? metadata.defaultLevel
      : undefined;
  if (thinking === "default") {
    if (defaultLevel === undefined)
      return yield* new PiModelSelectionError({
        kind: "validation",
        command: "set_thinking_level",
        detail: "Default reasoning level is not known; choose explicit level.",
      });
    level = defaultLevel;
  }
  // Support is model-dependent; never reuse levels from before set_model.
  const supported = yield* rpc("get_available_thinking_levels", client.getThinkingLevels());
  if (thinking === undefined && context.messageCount === 0) {
    const preferred = preferredReasoningLevel(
      supported.levels,
      defaultLevel,
      model.defaultReasoningLevel,
    );
    level = supported.levels.find((candidate) => candidate === preferred);
  }
  if (level !== undefined) {
    if (!supported.levels.includes(level))
      return yield* new PiModelSelectionError({
        kind: "validation",
        command: "set_thinking_level",
        detail: "Selected thinking level is not supported by this Pi model.",
      });
    yield* rpc("set_thinking_level", client.setThinkingLevel(level));
  }
  let state = yield* rpc("get_state", client.getState());
  if (
    state.model?.provider !== selected.provider ||
    state.model.id !== selected.modelId ||
    (level !== undefined && state.thinkingLevel !== level)
  )
    return yield* new PiModelSelectionError({
      kind: "request",
      command: "get_state",
      detail: "Pi did not apply the requested model or thinking level.",
    });
  const effectiveMetadata = state.model.reasoningMetadata;
  const reasoningKnown =
    effectiveMetadata === undefined ||
    (effectiveMetadata.status === "known" &&
      effectiveMetadata.supported === true &&
      effectiveMetadata.levels.length > 0);
  // Inherited effort may be clamped by the new model. Report the effective value;
  // explicit choices were checked above and must never be silently substituted.
  if (
    reasoningKnown &&
    thinking === undefined &&
    level === undefined &&
    supported.levels.length > 0 &&
    state.thinkingLevel !== undefined &&
    !supported.levels.includes(state.thinkingLevel)
  ) {
    const fallback = preferredReasoningLevel(
      supported.levels,
      defaultLevel,
      model.defaultReasoningLevel,
    );
    const replacement =
      supported.levels.find((candidate) => candidate === fallback) ?? supported.levels[0]!;
    yield* rpc("set_thinking_level", client.setThinkingLevel(replacement));
    state = yield* rpc("get_state", client.getState());
    if (
      state.model?.provider !== selected.provider ||
      state.model.id !== selected.modelId ||
      state.thinkingLevel !== replacement
    )
      return yield* new PiModelSelectionError({
        kind: "request",
        command: "get_state",
        detail: "Pi did not apply the supported thinking level.",
      });
  }
  if (
    reasoningKnown &&
    state.thinkingLevel !== undefined &&
    !supported.levels.includes(state.thinkingLevel)
  )
    return yield* new PiModelSelectionError({
      kind: "request",
      command: "get_state",
      detail: "Pi reports a thinking level that is not supported by the selected model.",
    });
  return {
    state: { ...state, model: state.model! },
    supportedThinkingLevels: supported.levels,
    confirmedThinkingLevel: reasoningKnown ? state.thinkingLevel : undefined,
  };
});

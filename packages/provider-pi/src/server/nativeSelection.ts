import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { encodePiModelSlug } from "./model.ts";
import { PiRpcProtocolError } from "./rpcClient.ts";
import { PiRpcModel, PiRpcState, PiRpcThinkingLevels, type PiThinkingLevel } from "./rpcSchema.ts";
import {
  piRecordField as recordField,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";

const decodeSelectionModel = Schema.decodeUnknownEffect(PiRpcModel);
export const decodeSelectionState = Schema.decodeUnknownEffect(PiRpcState);
const decodeSelectionThinkingLevels = Schema.decodeUnknownEffect(PiRpcThinkingLevels);

/** Native effort is observable only for a known model whose reasoning levels are known. */
export function observedNativeEffort(state: PiRpcState): PiThinkingLevel | undefined {
  const metadata = state.model?.reasoningMetadata;
  const known =
    state.model !== undefined &&
    (metadata === undefined ||
      (metadata.status === "known" && metadata.supported === true && metadata.levels.length > 0));
  return known ? state.thinkingLevel : undefined;
}

/** The selection Pi reports for its live native session, or null when its model is unknown. */
export function piNativeSelection(
  data: unknown,
  instanceId: ProviderInstanceId,
): ModelSelection | null {
  const model = recordField(data, "model");
  const provider = recordString(model, "provider");
  const id = recordString(model, "id");
  const thinkingLevel = recordString(data, "thinkingLevel");
  const slug =
    provider === undefined || id === undefined ? undefined : encodePiModelSlug(provider, id);
  return slug === undefined
    ? null
    : {
        instanceId,
        model: slug,
        ...(thinkingLevel === undefined
          ? {}
          : { options: [{ id: "thinkingLevel", value: thinkingLevel }] }),
      };
}

/** Use the same confirmed native selection policy as discovery and one-shot generation. */
export function makePiSelectionClient<E>(
  request: (record: PiRpcRecord) => Effect.Effect<unknown, E>,
) {
  const selectionRequest = (record: PiRpcRecord) =>
    request(record).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcProtocolError({
            detail: `Pi ${String(record.type)} failed.`,
            cause,
          }),
      ),
    );
  return {
    setModel: (provider: string, modelId: string) =>
      selectionRequest({ type: "set_model", provider, modelId }).pipe(
        Effect.flatMap(decodeSelectionModel),
        Effect.mapError(
          (cause) => new PiRpcProtocolError({ detail: "Invalid Pi model response.", cause }),
        ),
      ),
    getState: () =>
      selectionRequest({ type: "get_state" }).pipe(
        Effect.flatMap(decodeSelectionState),
        Effect.mapError(
          (cause) => new PiRpcProtocolError({ detail: "Invalid Pi state response.", cause }),
        ),
      ),
    getThinkingLevels: () =>
      selectionRequest({ type: "get_available_thinking_levels" }).pipe(
        Effect.flatMap(decodeSelectionThinkingLevels),
        Effect.mapError(
          (cause) =>
            new PiRpcProtocolError({ detail: "Invalid Pi thinking-level response.", cause }),
        ),
      ),
    setThinkingLevel: (level: PiThinkingLevel) =>
      selectionRequest({ type: "set_thinking_level", level }).pipe(Effect.asVoid),
  };
}

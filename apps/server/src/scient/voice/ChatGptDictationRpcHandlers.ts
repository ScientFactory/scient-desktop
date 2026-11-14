/** The composer's ChatGPT dictation, run by the Scient Agent instance the window names. */
import { ChatGptDictationError, WS_METHODS, WsWorkspaceRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";

export const makeChatGptDictationRpcHandlers = ({
  observeRpcEffect,
  providerInstances,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
}) =>
  ({
    [WS_METHODS.voiceDictateWithChatGpt]: (input) =>
      observeRpcEffect(
        WS_METHODS.voiceDictateWithChatGpt,
        Effect.gen(function* () {
          const instance = yield* providerInstances.getInstance(input.instanceId);
          if (!instance?.enabled || instance.voiceDictation === undefined)
            return yield* new ChatGptDictationError({ reason: "agent-unavailable" });
          return yield* instance.voiceDictation.dictate({
            wav: Buffer.from(input.audioBase64, "base64"),
            language: input.language,
          });
        }),
        { "rpc.aggregate": "voice" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    typeof WS_METHODS.voiceDictateWithChatGpt
  >;

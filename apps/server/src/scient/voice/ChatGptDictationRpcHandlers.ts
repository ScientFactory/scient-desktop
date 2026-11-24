/** The composer's ChatGPT dictation, run by the Scient Agent or Codex instance the window names. */
import { WS_METHODS, WsWorkspaceRpcGroup } from "@t3tools/contracts";
import { dictateWithChatGptInstance } from "../../transcription/chatgpt.ts";

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
        dictateWithChatGptInstance(
          providerInstances,
          input.instanceId,
          Buffer.from(input.audioBase64, "base64"),
          input.language,
        ),
        { "rpc.aggregate": "voice" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    typeof WS_METHODS.voiceDictateWithChatGpt
  >;

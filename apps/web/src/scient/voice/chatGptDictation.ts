// Dictation with ChatGPT: the recording goes to the environment's Scient Agent, which sends it to
// ChatGPT's own transcription service with its ChatGPT sign-in.
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type VoiceTranscriptionLanguage,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { connectionAtomRuntime } from "../../connection/runtime.ts";
import { useEnvironmentProviders } from "../../state/environments.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import { scientAgentChatGptSignedIn } from "../liveVoice/liveVoiceAvailability.ts";
import type { VoiceJobTranscriber } from "./voiceProcessing.ts";

export const SIGN_IN_TO_DICTATE_MESSAGE =
  "Sign in to ChatGPT in Scient Agent to dictate with ChatGPT.";

const chatGptDictationCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:dictate-with-chatgpt",
  tag: WS_METHODS.voiceDictateWithChatGpt,
  concurrency: { mode: "parallel" },
});

/** The environment's first enabled Scient Agent signed in to ChatGPT, if any. */
export function chatGptDictationInstance(
  providers: ReadonlyArray<ServerProvider> | undefined,
): ProviderInstanceId | null {
  const provider = providers?.find(
    (candidate) =>
      candidate.driver === "scient" &&
      candidate.enabled &&
      scientAgentChatGptSignedIn(candidate) === true,
  );
  return provider?.instanceId ?? null;
}

function failureMessage(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail" && reason.error instanceof Error && reason.error.message)
      return reason.error.message;
  }
  return "ChatGPT dictation isn't responding. Try again.";
}

/** Transcribes committed dictation with ChatGPT through one Scient Agent instance. */
export function makeChatGptDictationTranscriber<E>(
  run: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly instanceId: ProviderInstanceId;
      readonly audioBase64: string;
      readonly language?: VoiceTranscriptionLanguage;
    };
  }) => Promise<AtomCommandResult<{ readonly text: string }, E>>,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): VoiceJobTranscriber {
  return {
    transcribe: async (request) => {
      const result = await run({
        environmentId,
        input: {
          instanceId,
          audioBase64: request.audioBase64,
          ...(request.language ? { language: request.language } : {}),
        },
      });
      if (result._tag === "Failure") throw new Error(failureMessage(result.cause));
      return { text: result.value.text };
    },
  };
}

/** ChatGPT dictation in this environment, or null while no Scient Agent there is signed in to ChatGPT. */
export function useChatGptDictation(
  environmentId: EnvironmentId | undefined,
): VoiceJobTranscriber | null {
  const providersByEnvironment = useEnvironmentProviders();
  const run = useAtomCommand(chatGptDictationCommand, { reportFailure: false });
  if (environmentId === undefined) return null;
  const instanceId = chatGptDictationInstance(providersByEnvironment.get(environmentId));
  return instanceId === null
    ? null
    : makeChatGptDictationTranscriber(run, environmentId, instanceId);
}

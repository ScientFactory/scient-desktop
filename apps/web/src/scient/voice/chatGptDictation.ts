// Dictation with ChatGPT: the recording goes to the environment's Scient Agent or Codex, which
// sends it to ChatGPT's own transcription service with its ChatGPT sign-in.
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChatGptDictationError,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type VoiceTranscriptionLanguage,
  WS_METHODS,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import { msg } from "gt-react";

import { connectionAtomRuntime } from "../../connection/runtime.ts";
import { m } from "../../i18n/messages.ts";
import { useEnvironmentProviders } from "../../state/environments.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import { scientAgentChatGptSignedIn } from "../liveVoice/liveVoiceAvailability.ts";
import type { VoiceJobTranscriber } from "./voiceProcessing.ts";

export const SIGN_IN_TO_DICTATE_MESSAGE = new ChatGptDictationError({ reason: "signed-out" })
  .message;
const UPDATE_TO_DICTATE_MESSAGE = new ChatGptDictationError({ reason: "update-required" }).message;

/** The first Scient Agent release with dictation; the server refuses an older one. */
const SCIENT_AGENT_DICTATION_VERSION = "0.1.9";

const chatGptDictationCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:dictate-with-chatgpt",
  tag: WS_METHODS.voiceDictateWithChatGpt,
  concurrency: { mode: "parallel" },
});

function signedInToChatGpt(provider: ServerProvider): boolean {
  if (!provider.enabled) return false;
  if (provider.driver === "scient") return scientAgentChatGptSignedIn(provider) === true;
  return (
    provider.driver === "codex" &&
    provider.auth.status === "authenticated" &&
    provider.auth.type === "chatgpt"
  );
}

function agentTooOldToDictate(provider: ServerProvider): boolean {
  const version = provider.version;
  return (
    provider.driver === "scient" &&
    Boolean(version) &&
    compareSemverVersions(version ?? "", SCIENT_AGENT_DICTATION_VERSION) < 0
  );
}

/**
 * The provider instance that can dictate with ChatGPT in this environment, if any: an enabled
 * Scient Agent signed in to ChatGPT and new enough to dictate, else an enabled Codex signed in
 * with ChatGPT.
 */
export function chatGptDictationInstance(
  providers: ReadonlyArray<ServerProvider> | undefined,
): ProviderInstanceId | null {
  const capable = (providers ?? []).filter(
    (provider) => signedInToChatGpt(provider) && !agentTooOldToDictate(provider),
  );
  return (
    (
      capable.find((provider) => provider.driver === "scient") ??
      capable.find((provider) => provider.driver === "codex")
    )?.instanceId ?? null
  );
}

/** Why no instance can dictate: an update when only an outdated Scient Agent is signed in. */
export function chatGptDictationUnavailableMessage(
  providers: ReadonlyArray<ServerProvider> | undefined,
): string {
  return (providers ?? []).some(
    (provider) => signedInToChatGpt(provider) && agentTooOldToDictate(provider),
  )
    ? UPDATE_TO_DICTATE_MESSAGE
    : SIGN_IN_TO_DICTATE_MESSAGE;
}

function failureMessage(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail" && reason.error instanceof Error && reason.error.message)
      return reason.error.message;
  }
  return m(msg("ChatGPT dictation isn't responding. Try again."));
}

/** Transcribes committed dictation with ChatGPT through one provider instance. */
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

export interface ChatGptDictation {
  /** Null while no provider here can dictate with ChatGPT. */
  readonly transcriber: VoiceJobTranscriber | null;
  /** What to tell the user while `transcriber` is null. */
  readonly unavailableMessage: string;
}

/** ChatGPT dictation in this environment, through its Scient Agent or Codex. */
export function useChatGptDictation(environmentId: EnvironmentId | undefined): ChatGptDictation {
  const providersByEnvironment = useEnvironmentProviders();
  const run = useAtomCommand(chatGptDictationCommand, { reportFailure: false });
  const providers =
    environmentId === undefined ? undefined : providersByEnvironment.get(environmentId);
  const instanceId = chatGptDictationInstance(providers);
  return {
    transcriber:
      environmentId === undefined || instanceId === null
        ? null
        : makeChatGptDictationTranscriber(run, environmentId, instanceId),
    unavailableMessage: chatGptDictationUnavailableMessage(providers),
  };
}

import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
// Dictation with ChatGPT: the recording goes to the environment's Scient Agent or Codex, which
// sends it to ChatGPT's own transcription service with its ChatGPT sign-in.
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChatGptDictationError,
  defaultInstanceIdForDriver,
  type DictationInput,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  voiceLanguageRequestFields,
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

export const dictationCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:dictate",
  tag: WS_METHODS.voiceDictate,
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
  return m(msg("Dictation isn't responding. Try again."));
}

export function makeDictationTranscriber<E>(
  run: (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: DictationInput;
    },
    options?: { readonly signal: AbortSignal },
  ) => Promise<AtomCommandResult<{ readonly text: string }, E>>,
  environmentId: EnvironmentId,
  selection: DictationInput["selection"],
): VoiceJobTranscriber {
  return {
    transcribe: async (request, signal) => {
      const target = {
        environmentId,
        input: {
          selection,
          ...(selection.kind === "local"
            ? {
                silenceFiltering: getClientSettings().speechSilenceFiltering,
                removeFillerWords: getClientSettings().speechRemoveFillerWords,
              }
            : {}),
          audioBase64: request.audioBase64,
          ...(selection.kind !== "chatgpt" && request.hints?.length
            ? { hints: request.hints }
            : {}),
          ...voiceLanguageRequestFields(request.language),
        },
      };
      const result = signal ? await run(target, { signal }) : await run(target);
      if (result._tag === "Failure") throw new Error(failureMessage(result.cause));
      return { text: result.value.text };
    },
  };
}

export function makeChatGptDictationTranscriber<E>(
  run: Parameters<typeof makeDictationTranscriber<E>>[0],
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): VoiceJobTranscriber {
  return makeDictationTranscriber(run, environmentId, { kind: "chatgpt", instanceId });
}

export function resolveChatGptConnection(
  providers: readonly ServerProvider[],
  pinned?: ProviderInstanceId | null,
  active?: ProviderInstanceId,
) {
  const choices = providers.filter(
    (provider) => provider.enabled && (provider.driver === "codex" || provider.driver === "scient"),
  );
  const signedIn = choices.filter(
    (provider) => signedInToChatGpt(provider) && !agentTooOldToDictate(provider),
  );
  const codex = signedIn.filter((provider) => provider.driver === "codex");
  const candidates = codex.length ? codex : signedIn;
  const fallback =
    candidates.find(
      (provider) => provider.instanceId === defaultInstanceIdForDriver(provider.driver),
    ) ?? candidates[0];
  const selected = pinned
    ? choices.find((provider) => provider.instanceId === pinned)
    : (signedIn.find((provider) => provider.instanceId === active) ??
      fallback ??
      (choices.length === 1 ? choices[0] : undefined));
  return {
    choices,
    signedIn,
    selected,
    ready: selected !== undefined && signedIn.includes(selected),
  };
}

export interface ChatGptDictation {
  readonly connection: ReturnType<typeof resolveChatGptConnection>;
  readonly pinned: ProviderInstanceId | null;

  /** Null while no provider here can dictate with ChatGPT. */
  readonly transcriber: VoiceJobTranscriber | null;
  /** What to tell the user while `transcriber` is null. */
  readonly unavailableMessage: string;
}

/** ChatGPT dictation in this environment, through its Scient Agent or Codex. */
export function useChatGptDictation(
  environmentId: EnvironmentId | undefined,
  active?: ProviderInstanceId,
): ChatGptDictation {
  const providersByEnvironment = useEnvironmentProviders();
  const run = useAtomCommand(dictationCommand, { reportFailure: false });
  const providers =
    environmentId === undefined ? undefined : providersByEnvironment.get(environmentId);
  const pinned = useClientSettings((settings) => settings.voiceChatGptInstanceId) ?? null;
  const connection = resolveChatGptConnection(providers ?? [], pinned, active);
  const instanceId = connection.ready ? (connection.selected?.instanceId ?? null) : null;
  return {
    connection,
    pinned,
    transcriber:
      environmentId === undefined || instanceId === null
        ? null
        : makeChatGptDictationTranscriber(run, environmentId, instanceId),
    unavailableMessage: chatGptDictationUnavailableMessage(providers),
  };
}

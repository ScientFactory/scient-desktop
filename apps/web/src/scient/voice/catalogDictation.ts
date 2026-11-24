import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
} from "@t3tools/client-runtime/voice-input";
import { chooseSetupSpeechModel } from "@t3tools/shared/speech";
import { WS_METHODS, type VoiceLanguagePreference } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { isElectron } from "../../env";
import { useEnvironment } from "../../state/environments";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { preferredSpeechLanguages } from "../../speech/preferredSpeechLanguages";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { localEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { dictationCommand, makeDictationTranscriber } from "./chatGptDictation";
import { getVoiceBridge, type VoiceSetupClient } from "./voiceClient";

const dictationWaitCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:dictation-wait",
  tag: WS_METHODS.voiceDictationWait,
  concurrency: { mode: "parallel" },
});

const HEBREW_TURBO = "vladkens/ivrit-whisper-large-v3-turbo-gguf";
const MULTILINGUAL_TURBO = "handy-computer/whisper-large-v3-turbo-gguf";

export function legacyDictationCatalogModel(
  hasLegacySelection: boolean,
  language: VoiceLanguagePreference,
  preferred: readonly string[],
): string | null {
  if (!hasLegacySelection) return null;
  return language === "he" || (language === "auto" && preferred[0] === "he")
    ? HEBREW_TURBO
    : MULTILINGUAL_TURBO;
}

export function useCatalogDictation(language: VoiceLanguagePreference): {
  enabled: boolean;
  setup: VoiceSetupClient | null;
} {
  const environmentId = useAtomValue(localEnvironmentIdAtom);
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const serverConfig = useEnvironment(environmentId)?.serverConfig;
  const enabled =
    isElectron &&
    environmentId !== null &&
    (!serverConfig || serverConfig.environment.capabilities.catalogDictation !== undefined);
  const run = useStableCallback(useAtomCommand(dictationCommand, { reportFailure: false }));
  const wait = useStableCallback(useAtomCommand(dictationWaitCommand, { reportFailure: false }));
  const selected = useClientSettings((settings) => settings.voiceCatalogModelId);
  if (!enabled || !environmentId || !prepared) return { enabled, setup: null };
  const read = async (explicitModelId = selected) => {
    const [status, catalog, legacy] = await Promise.all([
      runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared)),
      runEnvironmentSpeech(getEnvironmentSpeechModels(prepared, true)),
      explicitModelId
        ? undefined
        : getVoiceBridge()
            ?.hadLegacySelection?.()
            .catch(() => undefined),
    ]);
    const preferred = preferredSpeechLanguages();
    const migratedId = legacyDictationCatalogModel(Boolean(legacy), language, preferred);
    const recommended = chooseSetupSpeechModel(catalog.models, {
      selectedModelId: "",
      intent: language,
      preferred,
      benchmarkTier: status.supported ? status.benchmarkTier : undefined,
    });
    const selectedModelId = explicitModelId ?? migratedId ?? recommended?.model.id ?? null;
    return {
      runtimeAvailable: status.supported,
      ...(status.supported ? {} : { runtimeMessage: status.reason }),
      selectedModelId,
      recommendation: migratedId
        ? { modelId: migratedId, language: language === "auto" ? (preferred[0] ?? null) : language }
        : recommended
          ? { modelId: recommended.model.id, language: recommended.language }
          : null,
      activeDownloadModelId:
        catalog.models.find((model) => model.state === "downloading" || model.state === "verifying")
          ?.id ?? null,
      models: catalog.models.map((model) => ({
        id: model.id,
        displayName: model.name,
        description: model.description,
        byteSize: model.size,
        ...(recommended?.language && model.benchmark?.accuracy[recommended.language]
          ? { grade: model.benchmark.accuracy[recommended.language]?.grade }
          : {}),
        state:
          model.state === "installed"
            ? { state: "ready" as const }
            : model.state === "downloading" || model.state === "verifying"
              ? { state: "downloading" as const, downloadedBytes: model.downloaded ?? 0 }
              : { state: "missing" as const },
      })),
    };
  };

  const select = (id: string) =>
    updateClientSettings({ voiceCatalogModelId: id, voiceDictationEngine: "local" });
  const forModel = (id: string) => {
    const transcriber = makeDictationTranscriber(run, environmentId, {
      kind: "local",
      modelId: id,
    });
    return {
      transcribe: async (...args: Parameters<typeof transcriber.transcribe>) => {
        const result = await transcriber.transcribe(...args);
        if (result.text.trim() && !args[1]?.aborted && !getClientSettings().voiceCatalogDictated) {
          void updateClientSettings({ voiceCatalogDictated: true }).catch(() => undefined);
        }
        return result;
      },
      waitingForWorker: async (signal: AbortSignal) => {
        const result = await wait({ environmentId, input: undefined }, { signal });
        return result._tag === "Success" && result.value.waiting;
      },
    };
  };
  const client: VoiceSetupClient = {
    ...forModel(selected ?? MULTILINGUAL_TURBO),
    getModelsState: () => read(),
    selectModel: async ({ modelId: id }) => {
      await select(id);
      return read(id);
    },
    downloadModel: async ({ modelId: id }) => {
      const result = await runEnvironmentSpeech(downloadEnvironmentSpeechModel(prepared, id));
      if (result.models.some((model) => model.id === id && model.state === "installed")) {
        await select(id);
      }
      return read(id);
    },
    cancelModelDownload: async ({ modelId: id }) => {
      await runEnvironmentSpeech(cancelEnvironmentSpeechModelDownload(prepared, id));
    },
    onModelDownloadProgress: (listener) => {
      let active = true;
      const interval = window.setInterval(() => {
        void runEnvironmentSpeech(getEnvironmentSpeechModels(prepared, false))
          .then(({ models }) => {
            if (!active) return;
            const model = models.find(
              (item) => item.state === "downloading" || item.state === "verifying",
            );
            if (model) {
              listener({
                modelId: model.id,
                downloadedBytes: model.downloaded ?? 0,
                totalBytes: model.size,
              });
            }
          })
          .catch(() => undefined);
      }, 500);
      return () => {
        active = false;
        window.clearInterval(interval);
      };
    },
    forModel,
  };
  return { enabled: true, setup: client };
}

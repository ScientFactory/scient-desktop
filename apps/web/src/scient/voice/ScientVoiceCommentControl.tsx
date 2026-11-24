import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useState, type ReactNode } from "react";

import { ScientVoiceComposerControl } from "./ScientVoiceComposerControl.tsx";
import { useClientSettings } from "../../hooks/useSettings.ts";
import { useChatGptDictation } from "./chatGptDictation.ts";
import { useCloudDictation } from "./cloudDictation";
import { useCatalogDictation } from "./catalogDictation";
import { hasReadySelectedVoiceModel } from "./voiceModelReadiness.ts";

/**
 * Citation comments consume an already configured voice setup. Model choice,
 * downloads and repair remain in the composer and Settings → Voice & Transcription.
 */
export function ScientVoiceCommentControl({
  disabled = false,
  environmentId,
  projectId,
  activeProviderInstanceId,
  onBusyChange,
  onTranscript,
  className,
}: {
  readonly disabled?: boolean;
  readonly activeProviderInstanceId?: ProviderInstanceId;
  readonly projectId?: ProjectId | null;
  readonly environmentId: EnvironmentId;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onTranscript: (text: string) => void;
  readonly className?: string;
}): ReactNode {
  const gt = useGT();
  const language = useClientSettings((settings) => settings.voiceLanguagePreference);
  const catalog = useCatalogDictation(language);
  const client = catalog.setup;
  const [ready, setReady] = useState(false);
  const engine = useClientSettings((settings) => settings.voiceDictationEngine);
  const cloudReady = useCloudDictation() !== null;
  const chatGptReady =
    useChatGptDictation(environmentId, activeProviderInstanceId).transcriber !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the voice client's model state when the client changes, ignoring stale completions
  useEffect(() => {
    if (!client) return;
    let current = true;
    void client
      .getModelsState()
      .then((snapshot) => {
        if (current) setReady(hasReadySelectedVoiceModel(snapshot));
      })
      .catch(() => {
        if (current) setReady(false);
      });
    return () => {
      current = false;
    };
  }, [client]);

  // Before an engine is chosen, a ChatGPT sign-in means the choice is still owed in the composer.
  const engineReady =
    engine === "off"
      ? false
      : engine === "chatgpt"
        ? chatGptReady
        : engine === "cloud"
          ? cloudReady
          : client !== null && ready && !(engine === "auto" && chatGptReady);
  if (!engineReady) return null;
  return (
    <ScientVoiceComposerControl
      ariaLabel={gt("Dictate citation comment")}
      {...(className ? { className } : {})}
      disabled={disabled}
      environmentId={environmentId}
      {...(activeProviderInstanceId ? { activeProviderInstanceId } : {})}
      projectId={projectId ?? null}
      {...(onBusyChange ? { onBusyChange } : {})}
      onTranscript={onTranscript}
      presentation="compact"
      readyModelOnly
    />
  );
}

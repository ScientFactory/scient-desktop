import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ScientVoiceComposerControl } from "./ScientVoiceComposerControl.tsx";
import { getVoiceBridge } from "./voiceClient.ts";
import { hasReadySelectedVoiceModel } from "./voiceModelReadiness.ts";

/**
 * Citation comments consume an already configured voice setup. Model choice,
 * downloads and repair remain in the composer and Settings → Voice.
 */
export function ScientVoiceCommentControl({
  disabled = false,
  environmentId,
  onBusyChange,
  onTranscript,
  className,
}: {
  readonly disabled?: boolean;
  readonly environmentId: EnvironmentId;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onTranscript: (text: string) => void;
  readonly className?: string;
}): ReactNode {
  const client = useMemo(() => getVoiceBridge(), []);
  const [ready, setReady] = useState(false);

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

  if (!client || !ready) return null;
  return (
    <ScientVoiceComposerControl
      ariaLabel="Dictate citation comment"
      {...(className ? { className } : {})}
      disabled={disabled}
      environmentId={environmentId}
      {...(onBusyChange ? { onBusyChange } : {})}
      onTranscript={onTranscript}
      presentation="compact"
      readyModelOnly
    />
  );
}

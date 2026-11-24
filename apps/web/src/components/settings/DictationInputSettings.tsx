import type { VoiceShortcutMode } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import {
  listAudioInputs,
  updateMicrophoneOrder,
  type BrowserMicrophone,
} from "../../speech/browserMicrophones";
import {
  microphoneOrder,
  preferredMicrophoneId,
  rememberMicrophones,
} from "../../speech/microphoneOrder";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MicrophoneOrderList } from "./MicrophoneOrderList";
import { MicrophoneTest } from "./MicrophoneTest";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const SHORTCUT_MODES: Record<VoiceShortcutMode, { label: string; hint: string }> = {
  auto: {
    label: msg("Auto", { $context: "dictation shortcut mode" }),
    hint: msg("Tap to toggle, hold to talk"),
  },
  hold: {
    label: msg("Hold", { $context: "dictation shortcut mode: record while the key is held" }),
    hint: msg("Record while held"),
  },
  toggle: {
    label: msg("Toggle", { $context: "dictation shortcut mode: tap to start and stop" }),
    hint: msg("Tap to start, tap to stop"),
  },
};
export function DictationInputSettings() {
  const gt = useGT();
  const messages = useMessages();
  const setting = useSearchableSetting();
  const settings = useClientSettings();
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const refreshMicrophones = useStableCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await listAudioInputs();
      setMicrophones(devices);
      updateMicrophoneOrder((order) => rememberMicrophones(order, devices));
    } catch {
      setMicrophones([]);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to microphone device changes while settings are open
  useEffect(() => {
    queueMicrotask(() => void refreshMicrophones());
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onChange = () => void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshMicrophones]);
  const order = microphoneOrder(settings);
  const selectedMicrophone = preferredMicrophoneId(order, microphones);
  return (
    <SettingsSection id="voice-input" title={gt("Input")}>
      <SettingsRow
        {...setting("voice-microphone")}
        title={gt("Microphone")}
        description={gt("Voice input uses the first connected microphone in this list.")}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={gt("Refresh microphones")}
                  onClick={() => void refreshMicrophones()}
                >
                  <RefreshCwIcon />
                </Button>
              }
            />
            <TooltipPopup>
              <T>Refresh microphones</T>
            </TooltipPopup>
          </Tooltip>
        }
      >
        <div className="mt-3 pb-2">
          <MicrophoneOrderList order={order} devices={microphones} />
        </div>
      </SettingsRow>
      <MicrophoneTest
        key={selectedMicrophone}
        microphoneId={selectedMicrophone}
        onMicrophoneAccess={() => void refreshMicrophones()}
      />
      <SettingsRow
        {...setting("dictation-shortcut-mode")}
        title={gt("Dictation shortcut")}
        description={`${messages(SHORTCUT_MODES[settings.voiceShortcutMode].hint)}.`}
        control={
          <Select
            value={settings.voiceShortcutMode}
            onValueChange={(value) => {
              if (value)
                void updateClientSettings({ voiceShortcutMode: value as VoiceShortcutMode });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Dictation shortcut mode")}>
              <SelectValue>
                {messages(SHORTCUT_MODES[settings.voiceShortcutMode].label)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(SHORTCUT_MODES) as VoiceShortcutMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  <span className="flex flex-col">
                    {messages(SHORTCUT_MODES[mode].label)}
                    <span className="text-xs text-muted-foreground">
                      {messages(SHORTCUT_MODES[mode].hint)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

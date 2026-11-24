// SCIENT-OWNED: where dictation runs, as cards like the Voice page's model cards.
import {
  type EnvironmentId,
  VOICE_LANGUAGE_NAMES,
  type VoiceLanguagePreference,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CheckIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { useVoiceModels } from "../../components/settings/VoiceSettingsPanel";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { ChatGptDictationCard } from "./ChatGptDictationCard";
import { useCloudRecordingChoices } from "./cloudDictation";

function ChoiceCard({
  title,
  description,
  detail,
  selected,
  onUse,
}: {
  readonly title: string;
  readonly description: string;
  readonly detail?: string | undefined;
  readonly selected: boolean;
  readonly onUse: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col rounded-xl border border-border/70 bg-card/50 p-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-sm">{title}</h3>
          {selected ? (
            <Badge variant="success" size="sm">
              <CheckIcon /> <T context="this dictation engine is the one in use">In use</T>
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">{description}</p>
        {detail ? <p className="text-muted-foreground/70 text-xs">{detail}</p> : null}
      </div>
      {selected ? null : (
        <div className="mt-3">
          <Button size="xs" variant="outline" onClick={onUse}>
            <T>Use</T>
          </Button>
        </div>
      )}
    </div>
  );
}

/** Automatic, ChatGPT, each installed model and each cloud engine, with Off below. */
export function DictationChoices({
  catalog,
  chatGptSignedIn,
  environmentId,
  language,
}: {
  readonly catalog: ReturnType<typeof useVoiceModels>;
  readonly chatGptSignedIn: boolean;
  readonly environmentId: EnvironmentId;
  readonly language: VoiceLanguagePreference;
}): ReactNode {
  const gt = useGT();
  const engine = useClientSettings((settings) => settings.voiceDictationEngine);
  const localModel = useClientSettings((settings) => settings.voiceCatalogModelId);
  const cloud = useClientSettings((settings) => settings.voiceCloudSelection);
  const { choices, choose } = useCloudRecordingChoices(environmentId);
  const [failed, setFailed] = useState(false);
  const chooseCloud = async (choice: (typeof choices)[number]) => {
    setFailed(false);
    const result = await choose({
      environmentId,
      input: { id: choice.id, origin: choice.origin, model: choice.model },
    });
    if (result._tag !== "Success") {
      setFailed(true);
      return;
    }
    await updateClientSettings({
      voiceDictationEngine: "cloud",
      voiceCloudSelection: { environmentId, engineId: choice.id },
    });
  };
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <ChoiceCard
          title={gt("Automatic")}
          description={
            language === "auto"
              ? gt("Uses the best installed model for the language you speak.")
              : gt("Uses the best installed model for {language}.", {
                  language: VOICE_LANGUAGE_NAMES[language],
                })
          }
          selected={engine === "auto"}
          onUse={() =>
            void updateClientSettings({ voiceDictationEngine: "auto", voiceCatalogModelId: null })
          }
        />
        <ChatGptDictationCard
          selected={engine === "chatgpt"}
          signedIn={chatGptSignedIn}
          offeredOnFirstUse={false}
          onSelect={() => void updateClientSettings({ voiceDictationEngine: "chatgpt" })}
        />
        {catalog.models
          .filter((model) => model.state === "installed")
          .map((model) => (
            <ChoiceCard
              key={model.id}
              title={model.name}
              description={model.description ?? gt("Runs on this computer.")}
              selected={engine === "local" && localModel === model.id}
              onUse={() =>
                void updateClientSettings({
                  voiceDictationEngine: "local",
                  voiceCatalogModelId: model.id,
                })
              }
            />
          ))}
        {choices
          .filter((choice) => !choice.reconnect && !choice.needsModel)
          .map((choice) => (
            <ChoiceCard
              key={choice.id}
              title={choice.model}
              description={gt("Cloud engine · {host}", {
                host: choice.origin.replace(/^https?:\/\//u, ""),
              })}
              selected={
                engine === "cloud" &&
                cloud?.environmentId === environmentId &&
                cloud.engineId === choice.id
              }
              onUse={() => void chooseCloud(choice)}
            />
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {engine === "off" ? (
          <>
            <span>
              <T>Dictation is off.</T>
            </span>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                void updateClientSettings({
                  voiceDictationEngine: "auto",
                  voiceCatalogModelId: null,
                })
              }
            >
              <T>Turn on</T>
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => void updateClientSettings({ voiceDictationEngine: "off" })}
          >
            <T>Turn off dictation</T>
          </Button>
        )}
        {failed ? (
          <span role="status">
            <T>Could not select this engine. Check its account in Accounts & secrets.</T>
          </span>
        ) : null}
      </div>
    </>
  );
}

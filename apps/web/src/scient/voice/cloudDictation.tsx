import { TranscriptionSelect } from "./TranscriptionSelect";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AccountId,
  WS_METHODS,
  type CloudDictationChoice,
  type EnvironmentId,
  type SpeechKeyCandidate,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "../../components/ui/dialog";
import { AccountDialog } from "../accounts/AccountDialog";
import { useAccounts } from "../accounts/useAccounts";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";

import { EllipsisIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { connectionAtomRuntime } from "../../connection/runtime";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useAtomCommand } from "../../state/use-atom-command";
import { dictationCommand, makeDictationTranscriber } from "./chatGptDictation";
import { andFinally } from "../../lib/compilerSafe";

const listChoices = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:cloud-choices",
  tag: WS_METHODS.voiceCloudChoices,
});

const chooseCloud = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:choose-cloud",
  tag: WS_METHODS.voiceChooseCloud,
});

const configureCloud = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:configure-cloud",
  tag: WS_METHODS.voiceConfigureCloud,
});

const listSavedKeys = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:saved-keys",
  tag: WS_METHODS.voiceSavedKeys,
});

function SpeechKeyAccountDialog({
  environmentId,
  name,
  origin,
  close,
  saved,
}: {
  environmentId: EnvironmentId;
  name: string;
  origin: string;
  close(): void;
  saved(id: AccountId): void;
}) {
  const accounts = useAccounts(environmentId);
  return accounts.data ? (
    <AccountDialog
      environmentId={environmentId}
      snapshot={accounts.data}
      account={null}
      canWrite={accounts.canWrite}
      initialApiKey={{ name, sites: [origin], speechOnly: true }}
      onClose={close}
      onSaved={saved}
    />
  ) : null;
}

const providers = {
  openai: { name: "OpenAI", origin: "https://api.openai.com", model: "gpt-transcribe" },
  xai: { name: "xAI", origin: "https://api.x.ai", model: "grok-voice-transcribe-2.0" },
  openrouter: { name: "OpenRouter", origin: "https://openrouter.ai", model: "" },
  compatible: { name: "OpenAI-compatible", origin: "", model: "" },
};

function AddCloudEngine({
  environmentId,
  onSaved,
  editing,
}: {
  environmentId: EnvironmentId;
  onSaved(): void;
  editing?: CloudDictationChoice;
}) {
  const gt = useGT();
  const list = useStableCallback(useAtomCommand(listSavedKeys, { reportFailure: false }));
  const [candidates, setCandidates] = useState<readonly SpeechKeyCandidate[]>([]);
  const [addingKey, setAddingKey] = useState(false);
  const configure = useAtomCommand(configureCloud, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<keyof typeof providers>(editing?.provider ?? "openai");
  const [account, setAccount] = useState("");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [model, setModel] = useState(editing?.model ?? "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const spec = providers[provider];
  const origin =
    provider === "compatible"
      ? URL.canParse(baseUrl)
        ? new URL(baseUrl).origin
        : ""
      : spec.origin;
  const available = candidates.filter((candidate) => candidate.origin === origin);
  const chosen = available.find(({ kind, id }) => kind + ":" + id === account);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh an owner-scoped list when the form's destination changes
  useEffect(() => {
    if (!open || !origin || addingKey) return;
    const controller = new AbortController();
    void list({ environmentId, input: { origin } }, { signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted)
          setCandidates(result._tag === "Success" ? result.value : []);
      },
    );
    return () => controller.abort();
  }, [addingKey, environmentId, list, open, origin]);

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!addingKey) setOpen(value);
      }}
    >
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {editing
          ? editing.needsModel
            ? gt("Choose model…")
            : editing.reconnect
              ? gt("Choose a saved key…")
              : gt("Change saved key…")
          : gt("Add a provider…")}
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{editing ? gt("Change saved key") : gt("Add a cloud engine")}</DialogTitle>
          <DialogDescription>
            {gt(
              "Choose a key from Accounts & secrets or reuse one from a Custom models connection for this provider.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!chosen || busy) return;
              setBusy(true);
              setFailed(false);
              await andFinally(
                async () => {
                  const result = await configure({
                    environmentId,
                    input: {
                      ...(editing && !editing.needsModel
                        ? { action: "update" as const, id: editing.id }
                        : { action: "add" as const }),
                      provider,
                      model: spec.model || model.trim(),
                      ...(chosen.kind === "account"
                        ? { accountId: AccountId.make(chosen.id) }
                        : { customModelConnectionId: chosen.id }),
                      ...(provider === "compatible" ? { baseUrl: baseUrl.trim() } : {}),
                    },
                  });
                  if (result._tag !== "Success") {
                    setFailed(true);
                    return;
                  }
                  setOpen(false);
                  onSaved();
                },
                () => {
                  setBusy(false);
                },
              );
            }}
          >
            <label className="grid gap-1 text-sm">
              {gt("Provider")}
              <TranscriptionSelect
                label={gt("Provider")}
                value={provider}
                options={Object.entries(providers).map(([value, item]) => ({
                  value: value as keyof typeof providers,
                  label: item.name,
                }))}
                onChange={(value) => {
                  setProvider(value);
                  setAccount("");
                  setModel("");
                }}
              />
            </label>
            {provider === "compatible" ? (
              <label className="grid gap-1 text-sm">
                {gt("Base URL")}
                <input
                  type="url"
                  required
                  className="rounded border bg-background p-2"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://speech.example.com/v1"
                />
              </label>
            ) : null}
            <label className="grid gap-1 text-sm">
              {gt("Model")}
              <input
                required
                readOnly={Boolean(spec.model)}
                className="rounded border bg-background p-2"
                value={spec.model || model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              {gt("Speech account")}
              <TranscriptionSelect
                label={gt("Speech account")}
                value={chosen ? chosen.kind + ":" + chosen.id : ""}
                options={[
                  { value: "", label: gt("Choose a speech account") },
                  ...available.map(({ id, kind, label, hint }) => ({
                    value: kind + ":" + id,
                    label:
                      (kind === "custom-model"
                        ? gt("Use the key from {name}", { name: label })
                        : label) + (hint ? ` (…${hint})` : ""),
                  })),
                ]}
                onChange={setAccount}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={!origin}
              onClick={() => setAddingKey(true)}
            >
              {gt("Add a key in Accounts…")}
            </Button>
            {failed ? (
              <p role="status">
                {gt("Could not add this engine. Check the account and provider details.")}
              </p>
            ) : null}
            <Button type="submit" disabled={!chosen || busy}>
              {editing && !editing.needsModel ? gt("Save binding") : gt("Add engine")}
            </Button>
          </form>
        </DialogPanel>
      </DialogPopup>
      {addingKey ? (
        <SpeechKeyAccountDialog
          environmentId={environmentId}
          name={spec.name}
          origin={origin}
          close={() => setAddingKey(false)}
          saved={(id) => setAccount("account:" + id)}
        />
      ) : null}
    </Dialog>
  );
}

export function useCloudDictation() {
  const selection = useClientSettings((settings) => settings.voiceCloudSelection);
  const run = useAtomCommand(dictationCommand, { reportFailure: false });
  return selection
    ? makeDictationTranscriber(run, selection.environmentId, {
        kind: "cloud",
        engineId: selection.engineId,
      })
    : null;
}

export function useCloudRecordingChoices(environmentId: EnvironmentId) {
  const list = useStableCallback(useAtomCommand(listChoices, { reportFailure: false }));
  const choose = useAtomCommand(chooseCloud, { reportFailure: false });
  const [choices, setChoices] = useState<readonly CloudDictationChoice[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the server inventory after engine changes
  useEffect(() => {
    const controller = new AbortController();
    void list({ environmentId, input: undefined }, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted && result._tag === "Success") setChoices(result.value);
    });
    return () => controller.abort();
  }, [environmentId, list]);
  return { choices, choose };
}

export function CloudDictationSettings({
  environmentId,
  manage = false,
  onEngineAdded,
}: {
  environmentId: EnvironmentId;
  manage?: boolean;
  onEngineAdded?: () => void;
}) {
  const gt = useGT();
  const list = useStableCallback(useAtomCommand(listChoices, { reportFailure: false }));
  const choose = useAtomCommand(chooseCloud, { reportFailure: false });
  const configure = useAtomCommand(configureCloud, { reportFailure: false });
  const [tested, setTested] = useState<{ id: string; ok: boolean } | null>(null);
  const selection = useClientSettings((settings) =>
    settings.voiceDictationEngine === "cloud" ? settings.voiceCloudSelection : null,
  );
  const [choices, setChoices] = useState<readonly CloudDictationChoice[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read the configured account choices for this environment
  useEffect(() => {
    const controller = new AbortController();
    void list({ environmentId, input: undefined }, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted && result._tag === "Success") setChoices(result.value);
    });
    return () => controller.abort();
  }, [environmentId, list]);

  return (
    <>
      {manage ? (
        <SettingsRow
          title={gt("Cloud speech engines")}
          description={gt(
            "OpenAI, xAI, OpenRouter or a compatible endpoint, with a key from Accounts.",
          )}
          control={
            <AddCloudEngine
              environmentId={environmentId}
              onSaved={() => {
                onEngineAdded?.();
                void list({ environmentId, input: undefined }).then((result) => {
                  if (result._tag === "Success") setChoices(result.value);
                });
              }}
            />
          }
        />
      ) : null}
      {choices
        .filter((choice) => manage || !choice.needsModel)
        .map((choice) => {
          const selected =
            selection?.environmentId === environmentId &&
            selection.engineId === choice.id &&
            choice.uploadConsent !== false;
          return (
            <SettingsRow
              key={choice.id}
              title={
                manage && choice.provider
                  ? [
                      ...new Set(
                        [providers[choice.provider].name, choice.keyLabel, choice.model].filter(
                          Boolean,
                        ),
                      ),
                    ].join(" · ")
                  : choice.model
              }
              description={
                choice.reconnect
                  ? gt("This key is unavailable. Choose a key to use this engine again.")
                  : choice.origin.replace(/^https?:\/\//u, "")
              }
              control={
                <div className="flex flex-wrap gap-2">
                  {manage ? (
                    <Button
                      size="sm"
                      variant="ghost-muted"
                      disabled={choice.reconnect || choice.needsModel || pending !== null}
                      aria-label={gt("Test {model} with silent audio", { model: choice.model })}
                      onClick={async () => {
                        setPending(choice.id);
                        await andFinally(
                          async () => {
                            const result = await configure({
                              environmentId,
                              input: { action: "test", id: choice.id },
                            });
                            setTested({ id: choice.id, ok: result._tag === "Success" });
                          },
                          () => {
                            setPending(null);
                          },
                        );
                      }}
                    >
                      {gt("Test connection")}
                    </Button>
                  ) : null}
                  {manage ? (
                    <>
                      <AddCloudEngine
                        environmentId={environmentId}
                        editing={choice}
                        onSaved={() => {
                          onEngineAdded?.();
                          void list({ environmentId, input: undefined }).then((result) => {
                            if (result._tag === "Success") setChoices(result.value);
                          });
                        }}
                      />
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-sm"
                              variant="ghost-muted"
                              aria-label={gt("More actions for {model}", { model: choice.model })}
                            />
                          }
                        >
                          <EllipsisIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem
                            render={
                              <Link
                                to={
                                  choice.customModelConnectionId
                                    ? "/settings/custom-models"
                                    : "/settings/accounts"
                                }
                              />
                            }
                          >
                            {gt("Manage key…")}
                          </MenuItem>
                          <MenuItem
                            variant="destructive"
                            disabled={choice.needsModel || pending !== null}
                            onClick={async () => {
                              setPending(choice.id);
                              await andFinally(
                                async () => {
                                  const result = await configure({
                                    environmentId,
                                    input: { action: "remove", id: choice.id },
                                  });
                                  if (result._tag !== "Success") {
                                    setFailed(true);
                                    return;
                                  }
                                  setChoices((current) =>
                                    current.filter((entry) => entry.id !== choice.id),
                                  );
                                  onEngineAdded?.();
                                },
                                () => {
                                  setPending(null);
                                },
                              );
                            }}
                          >
                            {gt("Remove engine")}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </>
                  ) : null}
                  {!manage ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={selected || choice.reconnect || pending !== null}
                      onClick={async () => {
                        setFailed(false);
                        setPending(choice.id);
                        await andFinally(
                          async () => {
                            const result = await choose({
                              environmentId,
                              input: { id: choice.id, origin: choice.origin, model: choice.model },
                            });
                            if (result._tag !== "Success") {
                              setFailed(true);
                              return;
                            }
                            setChoices((current) =>
                              current.map((entry) =>
                                entry.id === choice.id ? { ...entry, uploadConsent: true } : entry,
                              ),
                            );
                            await updateClientSettings({
                              voiceDictationEngine: "cloud",
                              voiceCloudSelection: { environmentId, engineId: choice.id },
                            });
                          },
                          () => {
                            setPending(null);
                          },
                        );
                      }}
                    >
                      {choice.reconnect
                        ? gt("Reconnect key")
                        : selected
                          ? gt("In use")
                          : gt("Use for dictation")}
                    </Button>
                  ) : null}
                </div>
              }
            >
              {tested?.id === choice.id ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {tested.ok ? gt("Connection works.") : gt("Connection test failed.")}
                </p>
              ) : null}
            </SettingsRow>
          );
        })}
      {manage && choices.some((choice) => choice.migrated) ? (
        <p className="px-3 text-xs text-muted-foreground">
          {gt("Your saved speech keys are available in Accounts.")}
        </p>
      ) : null}
      {failed ? (
        <p className="px-3 text-xs text-muted-foreground" role="status">
          {gt("Could not select this cloud engine. Check its speech account in Accounts.")}
        </p>
      ) : null}
    </>
  );
}

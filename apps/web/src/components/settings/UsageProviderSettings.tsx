import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { AddUsageAccountingSourceDialog } from "./AddUsageAccountingSourceDialog";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_PROXY_NAME = "CLI Proxy";
// SCIENT-FORK: the provider billing source.
const OPENROUTER_NAME = "OpenRouter";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  accountingSources,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly accountingSources: UnifiedSettings["usageAccountingSources"];
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState(false);
  const [addingAccounting, setAddingAccounting] = useState(false);
  const entries = Object.entries(sources);

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add hub</T>
            </Button>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow title={gt("No hubs configured.")} />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {source.enabled
                      ? CLI_PROXY_NAME
                      : gt("{name} · Disabled", { name: CLI_PROXY_NAME })}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      <SettingsSection
        title={gt("Provider billing")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAddingAccounting(true)}>
              <PlusIcon className="size-3" aria-hidden />
              <T>
                Connect <Var>{OPENROUTER_NAME}</Var>
              </T>
            </Button>
          ) : null
        }
      >
        {Object.entries(accountingSources).length === 0 ? (
          <SettingsRow
            title={gt("No billing source connected.")}
            description={gt(
              "Connect a management key to see provider-billed spend by API key and model. Scient uses it only for read-only accounting requests.",
            )}
          />
        ) : (
          Object.entries(accountingSources).map(([id, source]) => (
            <SettingsRow
              key={id}
              title={source.label?.trim() || OPENROUTER_NAME}
              description={
                source.enabled
                  ? gt("{name} analytics · Management key stored", { name: OPENROUTER_NAME })
                  : gt("{name} analytics · Disabled · Management key stored", {
                      name: OPENROUTER_NAME,
                    })
              }
              control={
                !readOnly ? (
                  <RemoveUsageProviderButton
                    label={source.label?.trim() || OPENROUTER_NAME}
                    detail={gt(
                      "Its stored management key will be deleted from this server. Cached billing rows stay local but no longer appear in Usage.",
                    )}
                    actionLabel={gt("Remove source")}
                    onConfirm={() => updateSettings({ usageAccountingSources: { [id]: null } })}
                  />
                ) : null
              }
            />
          ))
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
      {addingAccounting && !readOnly ? (
        <AddUsageAccountingSourceDialog
          open
          onOpenChange={setAddingAccounting}
          environmentId={environmentId}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  detail,
  actionLabel,
  onConfirm,
}: {
  readonly label: string;
  readonly detail?: string;
  readonly actionLabel?: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {detail ?? (
                <T>
                  The hub's management key is deleted from this server. Its accounts leave the
                  Limits view; the hub itself is untouched.
                </T>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {actionLabel ?? <T>Remove hub</T>}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

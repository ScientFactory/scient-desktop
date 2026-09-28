import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Switch } from "../ui/switch";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { AddUsageAccountingSourceDialog } from "./AddUsageAccountingSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Hub management follows the selected device and access rules of provider settings. */
export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  accountingSources,
  cursorKeychainUsageEnabled,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly accountingSources: UnifiedSettings["usageAccountingSources"];
  readonly cursorKeychainUsageEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const platform = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .platform;
  const [adding, setAdding] = useState(false);
  const [addingAccounting, setAddingAccounting] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const entries = Object.entries(sources);

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    try {
      const result = await updateCursorSettings({
        environmentId,
        input: { patch: { cursorKeychainUsageEnabled: enabled } },
      });
      if (result._tag === "Success") {
        await refreshProviders({ environmentId, input: {} });
      }
    } finally {
      setUpdatingCursor(false);
    }
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add hub
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title="Cursor account usage"
            description="Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access."
            control={
              <Switch
                aria-label="Cursor account usage"
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow title="No hubs configured." />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    CLI Proxy{source.enabled ? "" : " · Disabled"}
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
        title="Provider billing"
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAddingAccounting(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Connect OpenRouter
            </Button>
          ) : null
        }
      >
        {Object.entries(accountingSources).length === 0 ? (
          <SettingsRow
            title="No billing source connected."
            description="Connect a management key to see provider-billed spend by API key and model. Scient uses it only for read-only accounting requests."
          />
        ) : (
          Object.entries(accountingSources).map(([id, source]) => (
            <SettingsRow
              key={id}
              title={source.label?.trim() || "OpenRouter"}
              description={`OpenRouter analytics${source.enabled ? "" : " · Disabled"} · Management key stored`}
              control={
                !readOnly ? (
                  <RemoveUsageProviderButton
                    label={source.label?.trim() || "OpenRouter"}
                    detail="Its stored management key will be deleted from this server. Cached billing rows stay local but no longer appear in Usage."
                    actionLabel="Remove source"
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

/** Removing a hub deletes its stored management key, so it requires confirmation. */
function RemoveUsageProviderButton({
  label,
  detail = "The hub's management key is deleted from this server. Its accounts leave the Limits view; the hub itself is untouched.",
  actionLabel = "Remove hub",
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
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>{detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {actionLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

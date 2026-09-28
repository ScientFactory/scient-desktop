import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts/settings";
import { useState } from "react";

import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";

const DEFAULT_DAYS = 7;

/**
 * Settings → General → Organization: optional cleanup of empty sections.
 * Primary-only, like the section catalog it acts on: the value lives in the
 * primary environment's settings whatever environment the page has selected.
 */
export function EmptySectionCleanupSettings() {
  const afterDays = usePrimarySettings((settings) => settings.threadSectionsDeleteEmptyAfterDays);
  const updatePrimarySettings = useUpdatePrimarySettings();
  const update = (days: number | null) => {
    void updatePrimarySettings({ threadSectionsDeleteEmptyAfterDays: days });
  };
  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("delete-empty-sections")}
        description="Remove sidebar sections that have held no threads for this long. General is never removed."
        resetAction={
          afterDays !== DEFAULT_UNIFIED_SETTINGS.threadSectionsDeleteEmptyAfterDays ? (
            <SettingResetButton
              label="empty-section cleanup"
              onClick={() => update(DEFAULT_UNIFIED_SETTINGS.threadSectionsDeleteEmptyAfterDays)}
            />
          ) : null
        }
        control={
          <Switch
            checked={afterDays !== null}
            onCheckedChange={(checked) => update(checked ? DEFAULT_DAYS : null)}
            aria-label="Delete empty sections"
          />
        }
      />
      {afterDays !== null ? (
        <SettingsRow
          serverScoped
          title={searchableSetting("days-before-deleting-empty-sections").title}
          description="Adding a thread to a section restarts its count."
          control={<DaysInput value={afterDays} onCommit={update} />}
        />
      ) : null}
    </>
  );
}

/** Whole days, committed only when valid; snaps back to the saved value on blur. */
function DaysInput(props: { readonly value: number; readonly onCommit: (days: number) => void }) {
  // Keyed to the saved value, so a change saved elsewhere resets the draft.
  const [draft, setDraft] = useState({ saved: props.value, text: String(props.value) });
  const text = draft.saved === props.value ? draft.text : String(props.value);
  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={text}
      onChange={(event) => {
        setDraft({ saved: props.value, text: event.target.value });
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          props.onCommit(parsed);
        }
      }}
      onBlur={() => setDraft({ saved: props.value, text: String(props.value) })}
      aria-label="Days before deleting an empty section"
    />
  );
}

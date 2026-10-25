import { useRef } from "react";

import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ThreadTitleInstructionsSettings() {
  const settings = useScopedSettings();
  const { targets, scope } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef<string | null>(null);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadTitleInstructions"]);
  const editorKey = JSON.stringify([scope.kind, scopeKey, mixed, settings.threadTitleInstructions]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["threadTitleInstructions"]}
      {...searchableSetting("thread-title-instructions")}
      description="Appended to the prompt for new and regenerated thread titles."
      resetAction={
        mixed || settings.threadTitleInstructions !== "" ? (
          <SettingResetButton
            label="thread title instructions"
            onClick={() => updateSettings({ threadTitleInstructions: "" })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={editorKey}
          aria-label="Thread title instructions"
          onChange={() => {
            edited.current = editorKey;
          }}
          rows={4}
          defaultValue={mixed ? "" : settings.threadTitleInstructions}
          placeholder={
            mixed
              ? "Mixed. Enter instructions to apply to all selected targets."
              : "Keep titles to a few words. Lead with the main subject."
          }
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (
              edited.current === editorKey &&
              (mixed || value !== settings.threadTitleInstructions)
            )
              updateSettings({ threadTitleInstructions: value });
            edited.current = null;
          }}
        />
      </div>
    </SettingsRow>
  );
}

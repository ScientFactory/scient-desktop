// SCIENT-OWNED: the conversation text direction row in Settings → Appearance.
import type { ScientAnalyticsUiEvent } from "@t3tools/contracts";
import { type ContentDirection, DEFAULT_CONTENT_DIRECTION } from "@t3tools/contracts/settings";

import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

const CONTENT_DIRECTION_LABELS: Record<ContentDirection, string> = {
  auto: "Automatic",
  rtl: "Right to left",
  ltr: "Left to right",
};

/**
 * The appearance panel passes its scoped settings writer and analytics
 * recorder, so the row writes and records exactly what the panel would.
 */
export function ContentDirectionSettingsRow({
  contentDirection,
  updateSettings,
  recordAnalytics,
}: {
  readonly contentDirection: ContentDirection;
  readonly updateSettings: (patch: { readonly contentDirection: ContentDirection }) => void;
  readonly recordAnalytics: (event: ScientAnalyticsUiEvent) => void;
}) {
  return (
    <SettingsRow
      {...searchableSetting("conversation-text-direction")}
      description="Control chat prose, lists, and tables without mirroring the application shell."
      resetAction={
        contentDirection !== DEFAULT_CONTENT_DIRECTION ? (
          <SettingResetButton
            label="conversation text direction"
            onClick={() => updateSettings({ contentDirection: DEFAULT_CONTENT_DIRECTION })}
          />
        ) : null
      }
      control={
        <Select
          value={contentDirection}
          onValueChange={(value) => {
            if (value === "auto" || value === "rtl" || value === "ltr") {
              updateSettings({ contentDirection: value });
              recordAnalytics({
                name: "setting.changed",
                properties: {
                  setting: "direction",
                  value: value === "auto" ? "automatic" : value,
                },
              });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Conversation text direction">
            <SelectValue>{CONTENT_DIRECTION_LABELS[contentDirection]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(CONTENT_DIRECTION_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

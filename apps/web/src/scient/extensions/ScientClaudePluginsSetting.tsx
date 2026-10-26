import { supportsScientClaudePlugins, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { Switch } from "../../components/ui/switch";

const decodeConfig = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

export function ScientClaudePluginsSetting({
  provider,
  config,
  onChange,
}: {
  readonly provider: ServerProvider | undefined;
  readonly config: unknown;
  readonly onChange: (config: Record<string, unknown>) => void;
}) {
  if (provider?.driver !== "scient" || !supportsScientClaudePlugins(provider.version)) return null;
  const settings = decodeConfig(config);
  return (
    <SettingsRow
      title="Use my Claude Code plugins in Scient Agent"
      description="Use the plugins already installed in Claude Code."
    >
      <Switch
        checked={settings.useClaudePlugins !== false}
        aria-label="Use my Claude Code plugins in Scient Agent"
        onCheckedChange={(checked) => onChange({ ...settings, useClaudePlugins: checked })}
      />
    </SettingsRow>
  );
}

/**
 * How much conversation history a fork hands to a provider session that does
 * not hold it natively. SCIENT-OWNED; the server bounds every preset by the
 * model's context window.
 */
import {
  DEFAULT_FORK_CONTEXT_HANDOFF_SIZE,
  type EnvironmentId,
  type ForkContextHandoffSize,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

const SIZE_LABELS: Record<ForkContextHandoffSize, string> = {
  compact: msg("Compact", { $context: "size of the history a fork keeps" }),
  standard: msg("Standard", { $context: "size of the history a fork keeps" }),
  large: msg("Large", { $context: "size of the history a fork keeps" }),
  maximum: msg("Maximum", { $context: "size of the history a fork keeps" }),
};

const SIZE_DESCRIPTIONS: Record<ForkContextHandoffSize, string> = {
  compact: msg(
    "About 16k tokens of history. Fastest first reply; older messages are read on request.",
  ),
  standard: msg("About 64k tokens of history. A balance of memory and speed."),
  large: msg("About 128k tokens of history."),
  maximum: msg("As much history as the model's context window safely allows."),
};

const SIZES: ReadonlyArray<ForkContextHandoffSize> = ["compact", "standard", "large", "maximum"];

export function ForkContextSettings() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <EnvironmentForkContextSettings environmentId={environmentId} />;
}

function EnvironmentForkContextSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const size = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scientFork.contextHandoffSize,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [failure, setFailure] = useState<string | null>(null);

  const update = async (next: ForkContextHandoffSize) => {
    const result = await updateSettings({
      environmentId,
      input: { patch: { scientFork: { contextHandoffSize: next } } },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setFailure(cause instanceof Error ? cause.message : gt("The setting could not be saved."));
      return;
    }
    setFailure(null);
  };

  return (
    <SettingsSection id="forks" title={gt("Forks")}>
      <SettingsRow
        title={gt("History in forked conversations")}
        description={
          <>
            {m(SIZE_DESCRIPTIONS[size])}{" "}
            <T>
              Applies when a fork continues on a new provider session; forks the provider clones
              natively always keep everything.
            </T>
            {failure ? <span className="mt-1 block text-destructive">{failure}</span> : null}
          </>
        }
        control={
          <Select
            value={size}
            onValueChange={(value) => {
              if (value !== null && SIZES.includes(value as ForkContextHandoffSize)) {
                void update(value as ForkContextHandoffSize);
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={gt("History in forks")}>
              <SelectValue>
                {(value: ForkContextHandoffSize | null) =>
                  m(SIZE_LABELS[value ?? DEFAULT_FORK_CONTEXT_HANDOFF_SIZE])
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {SIZES.map((option) => (
                <SelectItem hideIndicator key={option} value={option}>
                  {m(SIZE_LABELS[option])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

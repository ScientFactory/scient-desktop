/**
 * Library (Sources) preferences. SCIENT-OWNED; the contact email reaches only Crossref, OpenAlex
 * and Unpaywall, and only when set.
 */
import { type EnvironmentId, usableRegistryContactEmail } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Input } from "~/components/ui/input";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

/** The setting belongs to the server the Documents page is showing. */
export function LibrarySettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scientSources.registryContactEmail,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const value = draft ?? saved;
  const invalid = value.trim() !== "" && usableRegistryContactEmail(value) === null;

  const save = async () => {
    if (draft === null || invalid || draft.trim() === saved) {
      setDraft(null);
      return;
    }
    const result = await updateSettings({
      environmentId,
      input: { patch: { scientSources: { registryContactEmail: draft.trim() } } },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setFailure(cause instanceof Error ? cause.message : gt("The setting could not be saved."));
      return;
    }
    setFailure(null);
    setDraft(null);
  };

  return (
    <SettingsSection
      id="library"
      title={gt("Library", { $context: "settings section for the personal Library of sources" })}
    >
      <SettingsRow
        title={gt("Contact email for reference registries")}
        description={
          <>
            <T>
              Crossref, OpenAlex and Unpaywall answer faster and more reliably when requests carry a
              contact address. Leave empty to send none.
            </T>
            {invalid ? (
              <span className="mt-1 block text-destructive">
                <T>Enter an email address.</T>
              </span>
            ) : null}
            {failure ? <span className="mt-1 block text-destructive">{failure}</span> : null}
          </>
        }
        control={
          <Input
            size="sm"
            type="email"
            className="w-full sm:w-64"
            aria-label={gt("Contact email for reference registries")}
            placeholder="you@university.edu"
            value={value}
            onValueChange={setDraft}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
        }
      />
    </SettingsSection>
  );
}

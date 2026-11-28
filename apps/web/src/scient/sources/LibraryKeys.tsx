import { AccountId, type EnvironmentId, type LibraryKeyUse } from "@t3tools/contracts";
import { LIBRARY_KEY_URLS, libraryKeyFits } from "@t3tools/shared/scientLibraryKeys";
import { msg, useGT, useMessages } from "gt-react";

import { SettingsRow } from "~/components/settings/settingsLayout";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { keyOptions } from "../accounts/ApiKeyAccountPicker";
import { libraryKeyTarget } from "../accounts/keyUses";
import { SavedKeyPicker } from "../accounts/SavedKeyPicker";
import { useAccounts } from "../accounts/useAccounts";

const USES = [
  ["zotero", msg("Zotero key")],
  ["openAlex", msg("OpenAlex key")],
  ["semanticScholar", msg("Semantic Scholar key")],
  ["ncbi", msg("NCBI / PubMed key")],
  ["googleBooks", msg("Google Books key")],
  ["unpaywallEmail", msg("Unpaywall email")],
] as const satisfies ReadonlyArray<readonly [LibraryKeyUse, unknown]>;

/** The key each Library lookup sends; a newer key never replaces the one chosen here. */
export function LibraryKeys({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const messages = useMessages();
  const { data: snapshot, canWrite } = useAccounts(environmentId);
  const chosen =
    useEnvironmentSettings(environmentId, (settings) => settings.scientSources?.keys) ?? {};
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  if (!snapshot) return null;
  return USES.map(([use, label]) => {
    const value = chosen[use];
    const options = keyOptions(
      snapshot,
      { kind: "library", id: use },
      (account) => libraryKeyFits(use, account),
      undefined,
      value,
    );
    if (!options.length && !value) return null;
    const site = new URL(LIBRARY_KEY_URLS[use]);
    return (
      <SettingsRow
        key={use}
        id={libraryKeyTarget(use)}
        title={messages(label)}
        control={
          <SavedKeyPicker
            environmentId={environmentId}
            snapshot={snapshot}
            canWrite={canWrite}
            size="sm"
            aria-label={messages(label)}
            emptyLabel={gt("Choose a key")}
            options={options}
            value={value ?? ""}
            add={{ name: messages(label), sites: [site.hostname] }}
            onPick={(accountId) => {
              if (accountId)
                void updateSettings({
                  environmentId,
                  input: {
                    patch: { scientSources: { keys: { [use]: AccountId.make(accountId) } } },
                  },
                });
            }}
          />
        }
      />
    );
  });
}

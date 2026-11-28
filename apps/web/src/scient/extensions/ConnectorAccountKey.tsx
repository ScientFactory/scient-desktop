import { type ConnectorSummary, type EnvironmentId, VaultSecretRef } from "@t3tools/contracts";
import { connectorKeyFits } from "@t3tools/shared/scientConnectorKeys";
import { useGT } from "gt-react";
import { SecretInput } from "~/components/settings/SecretInput";
import { useAtomCommand } from "~/state/use-atom-command";
import { keyOptions } from "../accounts/ApiKeyAccountPicker";
import { SavedKeyPicker } from "../accounts/SavedKeyPicker";
import { useAccounts } from "../accounts/useAccounts";
import { updateConnector } from "./extensionsState";

/** A key connector's Accounts key, which can be switched or added here instead of re-adding it. */
export function ConnectorAccountKey({
  environmentId,
  connector,
}: {
  readonly environmentId: EnvironmentId;
  readonly connector: ConnectorSummary;
}) {
  const gt = useGT();
  const { data: snapshot, canWrite } = useAccounts(environmentId);
  const update = useAtomCommand(updateConnector, { reportFailure: false });
  const auth = connector.auth;
  if (!snapshot || auth.type !== "credential" || !URL.canParse(connector.url)) return null;
  const origin = new URL(connector.url).origin;
  // Accounts can't name a plain-http address: such a service takes a typed key, checked first.
  if (!origin.startsWith("https://"))
    return (
      <SecretInput
        size="sm"
        configured
        value=""
        aria-label={gt("Key for {name}", { name: connector.displayName })}
        onCommit={(value) => {
          if (value.trim())
            void update({
              environmentId,
              input: { connectorId: connector.connectorId, credentialValue: value.trim() },
            });
        }}
      />
    );
  const options = keyOptions(
    snapshot,
    { kind: "connector", id: connector.connectorId },
    (account) =>
      connectorKeyFits(account, {
        ...auth,
        connectorId: connector.connectorId,
        url: connector.url,
      }),
    undefined,
    auth.accountId,
  );
  const refused = snapshot.keyRefusals?.some(
    ({ use }) => use.kind === "connector" && use.id === connector.connectorId,
  );
  return (
    <>
      {refused ? (
        <span className="text-xs text-destructive-foreground">{gt("Key refused")}</span>
      ) : null}
      <SavedKeyPicker
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        size="sm"
        aria-label={gt("Key for {name}", { name: connector.displayName })}
        emptyLabel={gt("Choose a key")}
        options={options}
        value={auth.accountId ?? ""}
        add={{
          name: connector.displayName,
          sites: [origin],
          ...(auth.strategy === "header"
            ? { auth: { type: "header", name: auth.headerName ?? "Authorization" } }
            : {}),
        }}
        onPick={(accountId) => {
          if (accountId && accountId !== auth.accountId)
            void update({
              environmentId,
              input: {
                connectorId: connector.connectorId,
                credentialRef: VaultSecretRef.make(`account:${accountId}:token`),
              },
            });
        }}
      />
    </>
  );
}

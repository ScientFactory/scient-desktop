import {
  AccountId,
  agentsMayUseEverywhere,
  type AccountSummary,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ApiKeyAccountPicker, keyOptions } from "./ApiKeyAccountPicker";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";

/** A provider variable is copied into an agent that serves every project: its key must fit all. */
export const variableKeyFits = (account: AccountSummary, agentAccess = true) =>
  account.secrets.token !== undefined && agentsMayUseEverywhere(account, agentAccess);

/** An agent variable's Accounts key: the key it follows, or one to follow instead of its own. */
export function VariableAccountKey({
  environmentId,
  instanceId,
  variable,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly variable: string;
}) {
  const gt = useGT();
  const { data: snapshot, canWrite } = useAccounts(environmentId);
  const link = useAccountCommand(accountsState.linkKey, environmentId);
  const unlink = useAccountCommand(accountsState.unlinkKey, environmentId);
  if (!snapshot) return null;
  const followed = snapshot.keyLinks?.find(
    (entry) => entry.instanceId === instanceId && entry.variable === variable,
  )?.accountId;
  const options = keyOptions(
    snapshot,
    { kind: "variable", id: `${instanceId}:${variable}` },
    (account) => variableKeyFits(account, snapshot.agentAccess),
  );
  if (!followed && !options.length) return null;
  return (
    <ApiKeyAccountPicker
      size="xs"
      aria-label={gt("Key in Accounts for {name}", { name: variable })}
      emptyLabel={gt("Its own key")}
      options={options}
      value={followed ?? ""}
      disabled={!canWrite}
      onChange={(event) => {
        const accountId = event.currentTarget.value;
        void (accountId
          ? link({ instanceId, variable, accountId: AccountId.make(accountId) })
          : unlink({ instanceId, variable }));
      }}
    />
  );
}

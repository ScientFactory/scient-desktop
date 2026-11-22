import { useGT } from "gt-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { Switch } from "~/components/ui/switch";
import { accountsState } from "./accountsState";
import { keptAgentKeys } from "./accountsView";
import { useAccountCommand, useAccounts } from "./useAccounts";

/** Keys kept in Accounts when an agent of this kind was removed, offered to the one being added. */
export function useKeptAgentKeys(environmentId: EnvironmentId, agent: string) {
  const accounts = useAccounts(environmentId);
  const putBack = useAccountCommand(accountsState.restoreKeptKeys, environmentId);
  const [declined, setDeclined] = useState(false);
  const keys = accounts.canWrite ? keptAgentKeys(accounts.data?.accounts ?? [], agent) : [];
  return {
    keys,
    declined,
    setDeclined,
    applyTo: async (instanceId: ProviderInstanceId) => {
      if (declined || keys.length === 0) return;
      await putBack({ instanceId, accountIds: keys.map((key) => key.accountId) });
    },
  };
}

export function KeptAgentKeysRow({
  kept,
  agentLabel,
}: {
  kept: ReturnType<typeof useKeptAgentKeys>;
  agentLabel: string;
}) {
  const gt = useGT();
  if (kept.keys.length === 0) return null;
  return (
    <SettingsRow
      title={gt("Use the keys from your earlier {agent}", { agent: agentLabel })}
      description={gt("Kept in Accounts when it was removed: {keys}", {
        keys: kept.keys.map((key) => key.name).join(", "),
      })}
      control={
        <Switch
          aria-label={gt("Use the keys from your earlier {agent}", { agent: agentLabel })}
          checked={!kept.declined}
          onCheckedChange={(checked) => kept.setDeclined(!checked)}
        />
      }
    />
  );
}

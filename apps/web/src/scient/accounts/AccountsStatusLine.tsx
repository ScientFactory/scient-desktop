import { T, useGT } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useAccounts } from "./useAccounts";

/**
 * Accounts on a computer that can't be shown or changed yet, in one line: loading, couldn't load
 * (why, with Retry), or read only. Another computer is named. Nothing once Accounts is usable.
 */
export function AccountsStatusLine({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const { data, canWrite, error, refresh } = useAccounts(environmentId);
  const environment = useEnvironment(environmentId);
  const computer = environmentId === usePrimaryEnvironmentId() ? undefined : environment?.label;
  if (error)
    return (
      <SettingsRow
        title={
          computer
            ? gt("Couldn't load accounts on {computer}", { computer })
            : gt("Couldn't load accounts")
        }
        description={error}
        control={
          <Button size="xs" variant="outline" onClick={refresh}>
            <T>Retry</T>
          </Button>
        }
      />
    );
  if (!data)
    return (
      <div className="px-4 py-3">
        <Skeleton className="h-4 w-40" />
      </div>
    );
  return canWrite ? null : <SettingsRow title={gt("Read only on this device")} />;
}

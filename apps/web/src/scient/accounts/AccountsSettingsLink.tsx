import { T, useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { BrowserProfilesSetting } from "~/components/settings/IntegrationsSettings";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { accountsAvailability } from "./accountsState";

export function AccountsSettingsLink({ disabled }: { disabled: boolean }) {
  const gt = useGT();
  const primary = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const available = useAtomValue(
    accountsAvailability(scope === null ? primary : (scope.environment?.environmentId ?? null)),
  );
  return available ? (
    <SettingsRow
      title={gt("Accounts & secrets")}
      control={
        <Link to="/settings/accounts" className="text-sm text-primary hover:underline">
          <T>Manage accounts</T>
        </Link>
      }
    />
  ) : (
    <BrowserProfilesSetting disabled={disabled} />
  );
}

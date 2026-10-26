import type {
  AccountStoresStatus,
  AccountWriteStore,
  AccountSecretSummary,
} from "@t3tools/contracts";
import { Checkbox } from "~/components/ui/checkbox";
import { NativeSelect } from "~/components/ui/select";

import { writableOnePasswordVaults } from "./accountsView";

export function SaveStores({
  stores,
  selected,
  onChange,
  kept,
}: {
  stores: AccountStoresStatus;
  kept?: AccountSecretSummary | undefined;
  selected: ReadonlyArray<AccountWriteStore>;
  onChange: (stores: ReadonlyArray<AccountWriteStore>) => void;
}) {
  const vaults = writableOnePasswordVaults(stores.onePassword);
  const existing = kept ? [kept.source, ...(kept.copies ?? [])] : [];
  const has = (type: AccountWriteStore["type"]) => existing.some((source) => source.type === type);
  const existingOnePassword = existing.find((source) => source.type === "1password");
  const existingVault =
    existingOnePassword?.type === "1password"
      ? vaults.find(
          (vault) =>
            vault.id === existingOnePassword.reference.split("/")[2] ||
            vault.name === existingOnePassword.reference.split("/")[2],
        )
      : undefined;
  const onePassword =
    selected.find((store) => store.type === "1password") ??
    (existingVault ? { type: "1password" as const, vaultId: existingVault.id } : undefined);
  const toggle = (store: AccountWriteStore, enabled: boolean) =>
    onChange(
      enabled
        ? [...selected.filter((entry) => entry.type !== store.type), store]
        : selected.filter((entry) => entry.type !== store.type),
    );
  return (
    <fieldset className="grid gap-2 text-sm">
      <legend className="mb-2 text-xs text-muted-foreground">Save to</legend>
      <label className="flex items-center gap-2">
        <Checkbox
          disabled={has("scient")}
          checked={has("scient") || selected.some((store) => store.type === "scient")}
          onCheckedChange={(checked) => toggle({ type: "scient" }, checked === true)}
        />
        Scient
      </label>
      {stores.keychain.available ? (
        <label className="flex items-center gap-2">
          <Checkbox
            disabled={has("keychain")}
            checked={has("keychain") || selected.some((store) => store.type === "keychain")}
            onCheckedChange={(checked) => toggle({ type: "keychain" }, checked === true)}
          />
          System keychain
        </label>
      ) : null}
      {vaults[0] ? (
        <label className="flex items-center gap-2">
          <Checkbox
            disabled={Boolean(existingVault)}
            checked={Boolean(onePassword)}
            onCheckedChange={(checked) =>
              toggle({ type: "1password", vaultId: vaults[0]!.id }, checked === true)
            }
          />
          1Password
        </label>
      ) : null}
      {onePassword && vaults.length > 1 ? (
        <NativeSelect
          aria-label="1Password vault"
          value={onePassword.vaultId}
          onChange={(event) => toggle({ type: "1password", vaultId: event.target.value }, true)}
        >
          {vaults.map((vault) => (
            <option key={vault.id} value={vault.id}>
              {vault.name}
            </option>
          ))}
        </NativeSelect>
      ) : onePassword ? (
        <span className="text-xs text-muted-foreground">
          {vaults.find((vault) => vault.id === onePassword.vaultId)?.name}
        </span>
      ) : null}
    </fieldset>
  );
}

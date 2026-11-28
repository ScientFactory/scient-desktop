import type { AccountsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { type ComponentProps, useState } from "react";
import { AccountDialog, type InitialApiKey } from "./AccountDialog";
import { ApiKeyAccountPicker } from "./ApiKeyAccountPicker";

/** `ApiKeyAccountPicker` with Add new wired to the shared key editor; the new key is chosen. */
export function SavedKeyPicker({
  environmentId,
  snapshot,
  canWrite,
  add,
  onPick,
  ...props
}: Omit<ComponentProps<typeof ApiKeyAccountPicker>, "onAdd" | "onChange"> & {
  readonly environmentId: EnvironmentId;
  readonly snapshot: AccountsSnapshot;
  readonly canWrite: boolean;
  readonly add?: InitialApiKey;
  /** The chosen option's value, `""` for none, or a new key's account id. */
  readonly onPick: (value: string, added?: boolean) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <ApiKeyAccountPicker
        {...props}
        {...(add && canWrite ? { onAdd: () => setAdding(true) } : {})}
        onChange={(event) => onPick(event.currentTarget.value)}
      />
      {adding && add ? (
        <AccountDialog
          environmentId={environmentId}
          snapshot={snapshot}
          account={null}
          canWrite={canWrite}
          initialApiKey={add}
          onClose={() => setAdding(false)}
          onSaved={(accountId) => onPick(accountId, true)}
        />
      ) : null}
    </>
  );
}

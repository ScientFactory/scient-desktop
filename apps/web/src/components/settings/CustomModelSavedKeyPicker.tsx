import { useState } from "react";
import { T, useGT } from "gt-react";
import {
  acceptsCustomModelKey,
  isCustomModelAccountOrigin,
  type AccountId,
  type AccountsSnapshot,
  type CustomModelProtocol,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AccountDialog } from "~/scient/accounts/AccountDialog";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { andFinally } from "../../lib/compilerSafe";

export function CustomModelSavedKeyPicker({
  environmentId,
  snapshot,
  name,
  baseUrl,
  currentAccountId,
  protocol,
  onChoose,
  onClose,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  name: string;
  baseUrl: string;
  currentAccountId?: AccountId;
  protocol: CustomModelProtocol;
  onChoose: (id: AccountId, name: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const gt = useGT();
  const [selection, setSelection] = useState<AccountId | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const origin = URL.canParse(baseUrl) ? new URL(baseUrl).origin : "";
  const keys = snapshot.accounts.filter((account) =>
    acceptsCustomModelKey(account, origin, protocol),
  );
  const selected = keys.find(({ accountId }) => accountId === selection);
  const choose = async (id: AccountId, label: string) => {
    setError(false);
    setBusy(true);
    await andFinally(
      async () => {
        try {
          await onChoose(id, label);
          onClose();
        } catch {
          setError(true);
        }
      },
      () => {
        setBusy(false);
      },
    );
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              <T>Choose saved key</T>
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {origin || gt("Enter the endpoint first.")}
              </p>
              {keys.length ? (
                <Select value={selection} onValueChange={setSelection} disabled={busy}>
                  <SelectTrigger aria-label={gt("Saved key")}>
                    <SelectValue placeholder={gt("Choose saved key…")}>
                      {selected?.name}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {keys.map((key) => (
                      <SelectItem key={key.accountId} value={key.accountId}>
                        {key.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
              <Button
                variant="outline"
                disabled={busy || !isCustomModelAccountOrigin(origin)}
                onClick={() => setAdding(true)}
              >
                <T>Add a key in Accounts…</T>
              </Button>
              {currentAccountId && selected && currentAccountId !== selected.accountId ? (
                <p className="text-sm text-muted-foreground">
                  <T>If both entries are the same key, you can share the selected saved key.</T>
                </p>
              ) : null}
              {selected ? (
                <Button
                  disabled={busy}
                  onClick={() => void choose(selected.accountId, selected.name)}
                >
                  {currentAccountId && currentAccountId !== selected.accountId
                    ? gt("Use this key for {name}", { name })
                    : gt("Use saved key")}
                </Button>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-muted-foreground">
                  <T>Could not use that key. Try again.</T>
                </p>
              ) : null}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      {adding ? (
        <AccountDialog
          environmentId={environmentId}
          snapshot={snapshot}
          account={null}
          initialApiKey={{ name: name || origin, sites: [origin], customModelProtocol: protocol }}
          canWrite
          onClose={() => setAdding(false)}
          onSaved={(id) => void choose(id, name || origin)}
        />
      ) : null}
    </>
  );
}

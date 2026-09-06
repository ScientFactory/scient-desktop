import { useState } from "react";
import type { CustomModelConnection, CustomModelSaveInput } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { CUSTOM_MODEL_PROTOCOLS } from "./customModels";

/** Connection-level settings: name and credential. Models are edited separately. */
export function CustomModelConnectionDialog({
  connection,
  revision,
  onSave,
  onDelete,
  onClose,
}: {
  connection: CustomModelConnection;
  revision: number;
  onSave: (input: CustomModelSaveInput) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const protocolName =
    CUSTOM_MODEL_PROTOCOLS.find((p) => p.id === connection.protocol)?.name ?? connection.protocol;
  const keyStatus = connection.credentialId
    ? connection.apiKeySuffix
      ? `Key ending in ${connection.apiKeySuffix}`
      : "Key saved"
    : "No API key";
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        revision,
        connection: {
          id: connection.id,
          name: name.trim(),
          protocol: connection.protocol,
          baseUrl: connection.baseUrl,
          models: connection.models,
        },
        ...(apiKey ? { apiKey: Redacted.make(apiKey) } : {}),
        ...(removeKey ? { removeKey: true } : {}),
      });
      setApiKey("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this connection.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Manage {connection.name}</DialogTitle>
          <DialogDescription className="sr-only">
            Rename this connection or change its API key.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-[var(--control-radius)] bg-muted/60 px-3 py-2.5 text-xs">
              <dt className="text-muted-foreground">Endpoint</dt>
              <dd className="min-w-0 break-all font-mono text-foreground">{connection.baseUrl}</dd>
              <dt className="text-muted-foreground">API format</dt>
              <dd className="text-foreground">{protocolName}</dd>
              <dt className="text-muted-foreground">Credential</dt>
              <dd className="text-foreground">{keyStatus}</dd>
            </dl>
            <fieldset disabled={busy} className="space-y-4">
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm/4 font-medium text-foreground">Name</span>
                <Input
                  required
                  autoFocus
                  maxLength={256}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm/4 font-medium text-foreground">
                  {connection.credentialId ? "Replace API key" : "API key"}
                </span>
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={16384}
                  disabled={removeKey}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={connection.credentialId ? "Leave blank to keep" : "Optional"}
                />
              </label>
              {connection.credentialId ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={removeKey}
                    onCheckedChange={(checked) => {
                      setRemoveKey(checked);
                      setApiKey("");
                    }}
                  />
                  Remove saved key
                </label>
              ) : null}
            </fieldset>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={onDelete}
              >
                Delete connection
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

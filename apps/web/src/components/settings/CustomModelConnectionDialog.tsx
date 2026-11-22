import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";
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
import { CUSTOM_MODEL_PROTOCOLS, MISSING_KEY_STATUS } from "./customModels";

/** Connection-level settings: name and credential. Models are edited separately. */
export function CustomModelConnectionDialog({
  connection,
  revision,
  onSave,
  onDelete,
  onClose,
  keyMissing = false,
}: {
  connection: CustomModelConnection;
  revision: number;
  /** An agent reported the saved key missing or unusable. */
  keyMissing?: boolean;
  onSave: (input: CustomModelSaveInput) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  // This dialog opens programmatically, so retain its invoking control for closure.
  const [opener] = useState(() => {
    if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;
    const control = document.activeElement;
    return control instanceof HTMLElement &&
      control !== document.body &&
      control !== document.documentElement
      ? { control, dialog: control.closest<HTMLElement>("[data-slot=dialog-popup]") }
      : null;
  });
  const [name, setName] = useState(connection.name);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const protocolName =
    CUSTOM_MODEL_PROTOCOLS.find((p) => p.id === connection.protocol)?.name ?? connection.protocol;
  // A missing key's last four describe nothing that can still be used.
  const missing = Boolean(connection.credentialId) && keyMissing;
  const keyStatus = !connection.credentialId
    ? gt("No API key")
    : missing
      ? messages(MISSING_KEY_STATUS)
      : connection.apiKeySuffix
        ? gt("Key ending in {suffix}", { suffix: connection.apiKeySuffix })
        : gt("Key saved");
  const submit = async () => {
    setBusy(true);
    setError(null);
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
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
        setError(cause instanceof Error ? cause.message : gt("Could not save this connection."));
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    setBusy(false);
    if (actionFailure) throw actionFailure.cause;
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup
        className="max-w-md"
        finalFocus={() =>
          opener?.control.isConnected
            ? opener.control
            : opener?.dialog?.isConnected
              ? opener.dialog
              : true
        }
      >
        <DialogHeader>
          <DialogTitle>
            <T>
              Manage <Var>{connection.name}</Var>
            </T>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <T>Rename this connection or change its API key.</T>
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
              <dt className="text-muted-foreground">
                <T>Endpoint</T>
              </dt>
              <dd className="min-w-0 break-all font-mono text-foreground">{connection.baseUrl}</dd>
              <dt className="text-muted-foreground">
                <T>API format</T>
              </dt>
              <dd className="text-foreground">{protocolName}</dd>
              <dt className="text-muted-foreground">
                <T>Credential</T>
              </dt>
              <dd className="text-foreground">{keyStatus}</dd>
            </dl>
            <fieldset disabled={busy} className="space-y-4">
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm/4 font-medium text-foreground">
                  <T context="connection name field">Name</T>
                </span>
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
                  {connection.credentialId && !missing ? gt("Replace API key") : gt("API key")}
                </span>
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={16384}
                  disabled={removeKey}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    missing
                      ? gt("Enter the API key again")
                      : connection.credentialId
                        ? gt("Leave blank to keep")
                        : gt("Optional")
                  }
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
                  <T>Remove saved key</T>
                </label>
              ) : null}
            </fieldset>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <Button type="button" variant="ghost-destructive" disabled={busy} onClick={onDelete}>
                <T>Delete connection</T>
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? gt("Saving…") : gt("Save", { $context: "button, saves the connection" })}
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

import {
  type AccountSummary,
  type ConnectorSummary,
  type EnvironmentId,
  type LocalConnectorSummary,
  type LocalBundleField,
  type LocalBundleSettingsInput,
  type LocalKeysInput,
  VaultSecretRef,
} from "@t3tools/contracts";

import { useState } from "react";

import { SecretInput } from "../../components/settings/SecretInput";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ApiKeyAccountPicker } from "../accounts/ApiKeyAccountPicker";
import { accountsState } from "../accounts/accountsState";
import { commandFailureMessage } from "./ExtensionsFeedback";
import { updateConnector } from "./extensionsState";

/** A plain answer as typed, or a key as an Accounts choice or a pasted value. */
export type SetupAnswer =
  | { readonly kind: "plain"; readonly value: string | boolean }
  | { readonly kind: "key"; readonly ref: string; readonly value: string };

const keyRef = (accountId: string) => `account:${accountId}:token`;

/** API-key accounts a key can use; the one whose variable matches the field comes first. */
export function useKeyAccounts(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(accountsState.snapshot({ environmentId, input: {} }));
  return (query.data?.accounts ?? []).filter(
    (account): account is AccountSummary & { details: { kind: "api-key" } } =>
      account.details.kind === "api-key",
  );
}

/** Answers to start from: current values, else defaults, else a matching saved key. */
export function initialAnswers(
  fields: ReadonlyArray<LocalBundleField>,
  accounts: ReadonlyArray<AccountSummary>,
  current?: {
    readonly values: Readonly<Record<string, unknown>>;
    readonly keys: ReadonlySet<string>;
  },
): Record<string, SetupAnswer> {
  const answers: Record<string, SetupAnswer> = {};
  for (const field of fields) {
    if (field.sensitive) {
      if (current?.keys.has(field.key)) continue;
      const match = accounts.find(
        (account) =>
          account.details.kind === "api-key" &&
          field.envName !== undefined &&
          account.details.envName === field.envName,
      );
      answers[field.key] = { kind: "key", ref: match ? keyRef(match.accountId) : "", value: "" };
      continue;
    }
    const value = current?.values[field.key] ?? field.default;
    if (value === undefined) continue;
    answers[field.key] = {
      kind: "plain",
      value:
        typeof value === "boolean"
          ? value
          : Array.isArray(value)
            ? value.join("\n")
            : String(value),
    };
  }
  return answers;
}

/** The input for `settings` and `keys`. Untouched keys are left as they are. */
export function setupInput(
  fields: ReadonlyArray<LocalBundleField>,
  answers: Readonly<Record<string, SetupAnswer>>,
): { readonly settings: LocalBundleSettingsInput; readonly keys: LocalKeysInput } | string {
  const settings: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  const keys: Record<string, LocalKeysInput[string]> = {};
  for (const field of fields) {
    const answer = answers[field.key];
    if (answer === undefined) continue;
    if (answer.kind === "key") {
      if (answer.ref) keys[field.key] = { type: "account", ref: VaultSecretRef.make(answer.ref) };
      else if (answer.value.trim()) keys[field.key] = { type: "value", value: answer.value.trim() };
      continue;
    }
    const { value } = answer;
    if (value === "") continue;
    if (typeof value === "boolean") settings[field.key] = value;
    else if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) return `${field.title} must be a number.`;
      settings[field.key] = number;
    } else if (field.multiple) {
      settings[field.key] = value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } else settings[field.key] = value;
  }
  return { settings, keys };
}

/**
 * A connector's settings and keys in plain words. A key can use a saved Accounts key or take a
 * pasted one, which Scient saves in Accounts. Anything left empty can be set up later.
 */
export function LocalSetupFields({
  fields,
  answers,
  accounts,
  keyStatus,
  onChange,
}: {
  readonly fields: ReadonlyArray<LocalBundleField>;
  readonly answers: Readonly<Record<string, SetupAnswer>>;
  readonly accounts: ReadonlyArray<AccountSummary>;
  /** For a connector being edited: the saved key each field uses now. */
  readonly keyStatus?: Readonly<Record<string, string>>;
  readonly onChange: (key: string, answer: SetupAnswer) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-4">
      {fields.map((field) => {
        const id = `local-setting-${field.key}`;
        const label = `${field.title}${field.required ? "" : " (optional)"}`;
        const answer = answers[field.key];
        const description = field.description ? (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        ) : null;
        if (field.sensitive) {
          const key =
            answer?.kind === "key" ? answer : { kind: "key" as const, ref: "", value: "" };
          return (
            <div key={field.key} className="grid gap-1.5">
              <Label htmlFor={id}>{label}</Label>
              <ApiKeyAccountPicker
                aria-label={`${field.title} key`}
                emptyLabel={
                  keyStatus?.[field.key] ? `Keep ${keyStatus[field.key]}` : "Paste a new key"
                }
                value={key.ref}
                options={accounts.map((account) => ({
                  value: keyRef(account.accountId),
                  name: account.name,
                }))}
                onChange={(event) => onChange(field.key, { ...key, ref: event.target.value })}
              />
              {key.ref ? null : (
                <SecretInput
                  id={id}
                  value={key.value}
                  placeholder={keyStatus?.[field.key] ? "Paste to replace it" : undefined}
                  onChange={(event) => onChange(field.key, { ...key, value: event.target.value })}
                />
              )}
              {description}
            </div>
          );
        }
        if (field.type === "boolean") {
          return (
            <div key={field.key} className="flex items-center justify-between gap-3">
              <Label htmlFor={id}>{field.title}</Label>
              <Switch
                id={id}
                checked={answer?.kind === "plain" && answer.value === true}
                onCheckedChange={(checked) =>
                  onChange(field.key, { kind: "plain", value: checked })
                }
              />
            </div>
          );
        }
        const text =
          answer?.kind === "plain" && typeof answer.value === "string" ? answer.value : "";
        return (
          <div key={field.key} className="grid gap-1.5">
            <Label htmlFor={id}>{label}</Label>
            {field.multiple ? (
              <Textarea
                id={id}
                rows={3}
                value={text}
                placeholder="One per line"
                onChange={(event) =>
                  onChange(field.key, { kind: "plain", value: event.target.value })
                }
              />
            ) : (
              <Input
                id={id}
                value={text}
                inputMode={field.type === "number" ? "decimal" : undefined}
                onChange={(event) =>
                  onChange(field.key, { kind: "plain", value: event.target.value })
                }
              />
            )}
            {description}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Keys are saved in Accounts & secrets and reach only this program. Anything left empty can be
        set up later; agents ask for it when they need it.
      </p>
    </div>
  );
}

/** Changes a local connector's settings and keys; running copies restart with them. */
export function LocalSetupDialog({
  connector,
  environmentId,
  onClose,
}: {
  readonly connector: ConnectorSummary & { readonly local: LocalConnectorSummary };
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const update = useAtomCommand(updateConnector, { reportFailure: false });
  const accounts = useKeyAccounts(environmentId);
  const fields = connector.local.setup.map((item) => item.field);
  const keyStatus = Object.fromEntries(
    connector.local.setup.flatMap((item) =>
      item.account === undefined ? [] : [[item.field.key, item.account]],
    ),
  );
  const [answers, setAnswers] = useState<Record<string, SetupAnswer>>(() =>
    initialAnswers(fields, accounts, {
      values: Object.fromEntries(
        connector.local.setup.flatMap((item) =>
          item.value === undefined ? [] : [[item.field.key, item.value]],
        ),
      ),
      keys: new Set(Object.keys(keyStatus)),
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const input = setupInput(fields, answers);
    if (typeof input === "string") return setError(input);
    setSaving(true);
    const result = await update({
      environmentId,
      input: { connectorId: connector.connectorId, localSetup: input },
    });
    setSaving(false);
    if (result._tag === "Success") onClose();
    else setError(commandFailureMessage(result));
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up {connector.displayName}</DialogTitle>
          <DialogDescription>Saving restarts it with these settings.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <LocalSetupFields
              fields={fields}
              answers={answers}
              accounts={accounts}
              keyStatus={keyStatus}
              onChange={(key, answer) => setAnswers((current) => ({ ...current, [key]: answer }))}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

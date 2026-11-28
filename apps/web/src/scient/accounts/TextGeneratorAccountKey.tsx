import {
  AccountId,
  accountKeyReference,
  acceptsTextGeneratorKey,
  type EnvironmentId,
  referencedAccountId,
  ACCOUNTS_PROTOCOL_2,
  type SettingsSecretValue,
  type TextGeneratorKind,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { keyOptions } from "./ApiKeyAccountPicker";
import { SavedKeyPicker } from "./SavedKeyPicker";
import { useAccounts } from "./useAccounts";

/** Saved keys a text generator can send to its endpoint; choosing one stores a reference. */
export function TextGeneratorAccountKey({
  environmentId,
  baseUrl,
  kind,
  generatorId,
  value,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly baseUrl: string;
  readonly kind: TextGeneratorKind;
  /** The generator's settings id; empty before it is saved. */
  readonly generatorId: string;
  readonly value: SettingsSecretValue;
  readonly disabled?: boolean;
  readonly onChange: (value: SettingsSecretValue) => void;
}) {
  const gt = useGT();
  const { data: snapshot, canWrite } = useAccounts(environmentId);
  const chosen = referencedAccountId(value);
  // An older server can't resolve the reference; the typed and named routes stay.
  if (!snapshot || (chosen === undefined && (snapshot.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL_2))
    return null;
  const origin = URL.canParse(baseUrl.trim()) ? new URL(baseUrl.trim()).origin : undefined;
  const options = keyOptions(
    snapshot,
    { kind: "text-generator", id: generatorId },
    (account) =>
      acceptsTextGeneratorKey(account, { id: generatorId, baseUrl: baseUrl.trim(), kind }),
    undefined,
    chosen,
  );
  const shown =
    chosen !== undefined && !options.some((option) => option.value === chosen)
      ? [...options, { value: chosen, name: gt("Removed key") }]
      : options;
  if (!shown.length && !origin?.startsWith("https://")) return null;
  const refused = snapshot.keyRefusals?.some(
    ({ use }) => use.kind === "text-generator" && use.id === generatorId,
  );
  return (
    <>
      {refused ? (
        <span className="text-xs text-destructive-foreground">{gt("Key refused")}</span>
      ) : null}
      <SavedKeyPicker
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        aria-label={gt("Key in Accounts")}
        emptyLabel={gt("Type a key")}
        options={shown}
        value={chosen ?? ""}
        disabled={disabled}
        {...(origin?.startsWith("https://")
          ? {
              add: {
                name: new URL(origin).host,
                sites: [origin],
                ...(kind === "anthropic" ? { auth: { type: "header", name: "x-api-key" } } : {}),
              } as const,
            }
          : {})}
        onPick={(id) => onChange(id ? accountKeyReference(AccountId.make(id)) : "")}
      />
    </>
  );
}

import type { AccountSummary, AccountsSnapshot, KeyUser } from "@t3tools/contracts";
import { useGT } from "gt-react";
import type { ComponentProps } from "react";
import { NativeSelect } from "~/components/ui/select";
import { keyChoices } from "./keyChoices";

const ADD = "\u0000add";

/** A saved key as a picker shows it; `value` is what the use stores (an id or a ref). */
export interface KeyOption {
  readonly value: string;
  readonly name: string;
  readonly account?: AccountSummary;
}

/** The keys a use may pick, filtered for it and with same-value rows shown once. */
export function keyOptions(
  snapshot: Pick<AccountsSnapshot, "accounts" | "sameKeys">,
  use: KeyUser,
  fits: (account: AccountSummary) => boolean,
  toValue: (account: AccountSummary) => string = (account) => account.accountId,
  chosen?: string,
): ReadonlyArray<KeyOption> {
  const chosenId = snapshot.accounts.find((account) => toValue(account) === chosen)?.accountId;
  return keyChoices(snapshot, use, fits, chosenId).map(({ account }) => ({
    value: toValue(account),
    name: account.name,
    account,
  }));
}

/** The one key picker: name, last four characters, project scope and state, then Add new. */
export function ApiKeyAccountPicker({
  options,
  emptyLabel,
  onAdd,
  onChange,
  ...props
}: Omit<ComponentProps<typeof NativeSelect>, "onChange"> & {
  readonly options: ReadonlyArray<KeyOption>;
  readonly emptyLabel?: string;
  /** Offers "Add new…", which opens the shared key editor. */
  readonly onAdd?: () => void;
  readonly onChange?: ComponentProps<typeof NativeSelect>["onChange"];
}) {
  const gt = useGT();
  const describe = ({ name, account }: KeyOption) => {
    if (!account) return name;
    const hint = account.secrets.token?.hint;
    const scope = account.controls.scope;
    return [
      name,
      hint ? `…${hint}` : undefined,
      scope.type === "projects"
        ? gt("{count, plural, one {{count} project} other {{count} projects}}", {
            count: scope.projectIds.length,
          })
        : undefined,
      account.signIn?.state === "failed"
        ? gt("Key refused")
        : account.controls.access === "off"
          ? gt("Off", { $context: "agents may not use this key" })
          : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <NativeSelect
      {...props}
      onChange={(event) => {
        if (event.currentTarget.value === ADD) {
          event.currentTarget.value = String(props.value ?? "");
          onAdd?.();
          return;
        }
        onChange?.(event);
      }}
    >
      <option value="">{emptyLabel ?? gt("Choose an account")}</option>
      <optgroup label={gt("Use an existing account")}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {describe(option)}
          </option>
        ))}
      </optgroup>
      {onAdd ? <option value={ADD}>{gt("Add new…")}</option> : null}
    </NativeSelect>
  );
}

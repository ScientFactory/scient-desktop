import type { ComponentProps } from "react";
import { NativeSelect } from "~/components/ui/select";

export function ApiKeyAccountPicker({
  options,
  emptyLabel = "Choose an account",
  ...props
}: ComponentProps<typeof NativeSelect> & {
  readonly options: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly emptyLabel?: string;
}) {
  return (
    <NativeSelect {...props}>
      <option value="">{emptyLabel}</option>
      <optgroup label="Use an existing account">
        {options.map((account) => (
          <option key={account.value} value={account.value}>
            {account.name}
          </option>
        ))}
      </optgroup>
    </NativeSelect>
  );
}

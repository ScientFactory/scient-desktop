import { useGT } from "gt-react";
import type { ComponentProps } from "react";
import { NativeSelect } from "~/components/ui/select";

export function ApiKeyAccountPicker({
  options,
  emptyLabel,
  ...props
}: ComponentProps<typeof NativeSelect> & {
  readonly options: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly emptyLabel?: string;
}) {
  const gt = useGT();
  return (
    <NativeSelect {...props}>
      <option value="">{emptyLabel ?? gt("Choose an account")}</option>
      <optgroup label={gt("Use an existing account")}>
        {options.map((account) => (
          <option key={account.value} value={account.value}>
            {account.name}
          </option>
        ))}
      </optgroup>
    </NativeSelect>
  );
}

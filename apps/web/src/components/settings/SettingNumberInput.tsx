// FILE: SettingNumberInput.tsx
// Purpose: Let settings number fields keep an editable draft and normalize only when committed.
// Layer: Settings UI components

import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react";

import { Input } from "~/components/ui/input";

type SettingNumberInputProps = Omit<
  ComponentProps<typeof Input>,
  "value" | "defaultValue" | "onChange"
> & {
  /** Committed settings value. */
  value: number;
  /** Applies the setting's rounding and range rules when the draft is committed. */
  normalizeValue: (value: number) => number;
  /** Called after blur or Enter when the normalized value changed. */
  onCommit: (value: number) => void;
};

export function SettingNumberInput({
  value,
  normalizeValue,
  onCommit,
  onBlur,
  onFocus,
  onKeyDown,
  ...inputProps
}: SettingNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const draftRef = useRef(String(value));
  const focusedRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const normalizeValueRef = useRef(normalizeValue);
  normalizeValueRef.current = normalizeValue;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const replaceDraft = useCallback((nextDraft: string) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);

  // Honor changes from elsewhere (including Restore defaults) without replacing text mid-edit.
  useEffect(() => {
    if (!focusedRef.current) {
      replaceDraft(String(value));
    }
  }, [replaceDraft, value]);

  const commit = useCallback(() => {
    const nextValue = Number(draftRef.current.trim());
    if (draftRef.current.trim() === "" || !Number.isFinite(nextValue)) {
      replaceDraft(String(valueRef.current));
      return;
    }

    const normalizedValue = normalizeValueRef.current(nextValue);
    replaceDraft(String(normalizedValue));
    if (normalizedValue !== valueRef.current) {
      onCommitRef.current(normalizedValue);
    }
  }, [replaceDraft]);

  return (
    <Input
      {...inputProps}
      value={draft}
      onChange={(event) => replaceDraft(event.target.value)}
      onFocus={(event) => {
        focusedRef.current = true;
        onFocus?.(event);
      }}
      onBlur={(event) => {
        focusedRef.current = false;
        commit();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        onKeyDown?.(event);
      }}
    />
  );
}

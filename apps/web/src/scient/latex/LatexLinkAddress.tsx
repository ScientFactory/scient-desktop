import { useState } from "react";
import { Input } from "~/components/ui/input";
import { DockMenu, DockCommandItem } from "../writing/dockChrome";
import { LatexContextMenuForm } from "./LatexContextMenuForm";

export function LatexLinkAddress(props: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <DockMenu
      icon={undefined}
      label="Address"
      commandScope="latex"
      disabled={props.disabled}
      popupClassName="w-max min-w-0 max-w-(--available-width)"
    >
      <LinkAddressDraft key={props.value} value={props.value} onChange={props.onChange} />
    </DockMenu>
  );
}
function LinkAddressDraft(props: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  const valid = /^(https?:\/\/|mailto:)/iu.test(draft) && !/[{}\\\s]/u.test(draft);
  return (
    <LatexContextMenuForm label="Link address" width="content">
      <Input
        size="compact"
        type="url"
        aria-label="Link address"
        value={draft}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
      />
      <DockCommandItem disabled={!valid} onClick={() => props.onChange(draft)}>
        Apply
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}

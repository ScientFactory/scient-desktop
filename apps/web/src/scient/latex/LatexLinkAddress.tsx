import { useState } from "react";
import { Input } from "~/components/ui/input";
import { DockMenu, DockCommandItem } from "../writing/dockChrome";
import { LatexContextMenuForm } from "./LatexContextMenuForm";
import { T, useGT } from "gt-react";

export function LatexLinkAddress(props: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const gt = useGT();
  return (
    <DockMenu
      icon={undefined}
      label={gt("Address", { $context: "link URL" })}
      commandScope="latex"
      disabled={props.disabled}
      popupClassName="w-max min-w-0 max-w-(--available-width)"
    >
      <LinkAddressDraft key={props.value} value={props.value} onChange={props.onChange} />
    </DockMenu>
  );
}
function LinkAddressDraft(props: { value: string; onChange: (value: string) => void }) {
  const gt = useGT();
  const [draft, setDraft] = useState(props.value);
  const valid = /^(https?:\/\/|mailto:)/iu.test(draft) && !/[{}\\\s]/u.test(draft);
  return (
    <LatexContextMenuForm label={gt("Link address")} width="content">
      <Input
        size="compact"
        type="url"
        aria-label={gt("Link address")}
        value={draft}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
      />
      <DockCommandItem disabled={!valid} onClick={() => props.onChange(draft)}>
        <T>Apply</T>
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}

import { useGT, useMessages } from "gt-react";
import type { ReactNode } from "react";
import { MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { WRITING_COMMAND_LABELS } from "./commandNames";
import { DockMenu } from "./dockChrome";

export type TextMenuContents = {
  paragraphStyle: ReactNode;
  formatting: ReactNode;
  alignment?: ReactNode;
  direction?: ReactNode;
  directionLabel?: string;
  commandScope?: string;
};

/** Shared categories; each editor supplies only commands its source can store. */
export function TextMenuItems(props: TextMenuContents) {
  const gt = useGT();
  const category = (label: string, children: ReactNode, compact = false) => (
    <MenuSub>
      <MenuSubTrigger>{label}</MenuSubTrigger>
      <MenuSubPopup
        width={compact ? "compact" : "default"}
        className={compact ? "w-max" : "w-max min-w-48"}
        data-dock-command-scope={props.commandScope}
      >
        {children}
      </MenuSubPopup>
    </MenuSub>
  );
  return (
    <>
      {category(gt("Paragraph style"), props.paragraphStyle)}
      {category(gt("Formatting", { $context: "text formatting commands" }), props.formatting)}
      {props.alignment
        ? category(gt("Alignment", { $context: "text alignment" }), props.alignment)
        : null}
      {props.direction
        ? category(
            props.directionLabel ?? gt("Direction", { $context: "text direction" }),
            props.direction,
            true,
          )
        : null}
    </>
  );
}

export function TextMenu(props: TextMenuContents & { disabled?: boolean }) {
  const m = useMessages();
  const label = m(WRITING_COMMAND_LABELS.text);
  return (
    <DockMenu
      label={label}
      icon={<span className="text-[13px]">{label}</span>}
      disabled={props.disabled ?? false}
      commandScope={props.commandScope}
      popupClassName="w-max min-w-40"
    >
      <TextMenuItems {...props} />
    </DockMenu>
  );
}

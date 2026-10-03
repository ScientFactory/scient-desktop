import type { ReactNode } from "react";
import { MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { DockMenu } from "./dockChrome";

export type TextMenuContents = {
  paragraphStyle: ReactNode;
  formatting: ReactNode;
  direction?: ReactNode;
  directionLabel?: string;
  commandScope?: string;
};

/** Shared categories; each editor supplies only commands its source can store. */
export function TextMenuItems(props: TextMenuContents) {
  const category = (label: string, children: ReactNode) => (
    <MenuSub>
      <MenuSubTrigger>{label}</MenuSubTrigger>
      <MenuSubPopup className="w-max min-w-48" data-dock-command-scope={props.commandScope}>
        {children}
      </MenuSubPopup>
    </MenuSub>
  );
  return (
    <>
      {category("Paragraph style", props.paragraphStyle)}
      {category("Formatting", props.formatting)}
      {props.direction ? category(props.directionLabel ?? "Direction", props.direction) : null}
    </>
  );
}

export function TextMenu(props: TextMenuContents & { disabled?: boolean }) {
  return (
    <DockMenu
      label="Text"
      icon={<span className="text-[13px]">Text</span>}
      disabled={props.disabled ?? false}
      commandScope={props.commandScope}
      popupClassName="w-max min-w-40"
    >
      <TextMenuItems {...props} />
    </DockMenu>
  );
}

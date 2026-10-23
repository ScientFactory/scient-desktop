import { useId, type ReactNode } from "react";
import { MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";

/** Keep nested footer menus in the same selection and keyboard scope. */
export function LatexFooterSubmenu(props: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <MenuSub>
      <MenuSubTrigger id={id} disabled={props.disabled}>
        {props.label}
      </MenuSubTrigger>
      <MenuSubPopup
        className="w-max min-w-0 max-w-(--available-width)"
        data-writing-menu-owner={id}
        data-dock-command-scope="latex"
        data-keybinding-capture=""
      >
        {props.children}
      </MenuSubPopup>
    </MenuSub>
  );
}

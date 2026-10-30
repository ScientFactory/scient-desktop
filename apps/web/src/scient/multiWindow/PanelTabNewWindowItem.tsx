import { AppWindowIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { MenuItem, MenuSeparator } from "~/components/ui/menu";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { RightPanelSurface } from "~/rightPanelStore";

/** Opens the side panel tab a page shows in a new window; null outside a tab and where no window can open. */
const PanelTabNewWindowContext = createContext<(() => void) | null>(null);

export function PanelTabNewWindowProvider(props: {
  readonly surface: RightPanelSurface | null;
  readonly onOpen: ((surface: RightPanelSurface) => void) | undefined;
  readonly children: ReactNode;
}) {
  // Stable, so the pages that read it do not render again with the chat.
  const open = useStableCallback(() => {
    if (props.surface) props.onOpen?.(props.surface);
  });
  return (
    <PanelTabNewWindowContext value={props.surface && props.onOpen ? open : null}>
      {props.children}
    </PanelTabNewWindowContext>
  );
}

/**
 * "Open in new window" in a page's own menu, for the tab that shows the page. Renders nothing
 * outside a tab and where no window can open.
 */
export function PanelTabNewWindowItem(props: {
  /** For a menu that offers other windows, such as the browser's. */
  readonly label?: string;
  /** For a menu whose items have no icons. */
  readonly plain?: boolean;
  readonly iconClassName?: string;
  /** Puts the item in a group of its own at the end of the menu. */
  readonly separated?: boolean;
}) {
  const open = useContext(PanelTabNewWindowContext);
  if (!open) return null;
  return (
    <>
      {props.separated ? <MenuSeparator /> : null}
      <MenuItem onClick={open}>
        {props.plain ? null : <AppWindowIcon className={props.iconClassName} />}
        {props.label ?? "Open in new window"}
      </MenuItem>
    </>
  );
}

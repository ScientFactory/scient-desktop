import { AppWindowIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { MenuItem } from "~/components/ui/menu";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { RightPanelSurface } from "~/rightPanelStore";

/** Opens the side panel tab a page shows in a new window; null outside a tab and where no window can open. */
const PanelTabNewWindowContext = createContext<(() => void) | null>(null);

export function usePanelTabNewWindow() {
  return useContext(PanelTabNewWindowContext);
}

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

/** "Open in new window" in a page's own menu, for the tab that shows the page. */
export function PanelTabNewWindowItem(props: {
  readonly onOpen: () => void;
  /** For a menu that offers other windows, such as the browser's. */
  readonly label?: string;
  /** For a menu whose items have no icons. */
  readonly plain?: boolean;
  readonly iconClassName?: string;
}) {
  return (
    <MenuItem onClick={props.onOpen}>
      {props.plain ? null : <AppWindowIcon className={props.iconClassName} />}
      {props.label ?? "Open in new window"}
    </MenuItem>
  );
}

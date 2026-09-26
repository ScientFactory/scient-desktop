import { ChevronDownIcon, ListFilterIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "../../components/sidebar/SidebarThreadHeader";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import type { SidebarViewMode } from "./logic";

/**
 * Sidebar view options: group threads by lifecycle status (the default) or by
 * user-defined section. The tooltip names the current grouping.
 */
export function SidebarViewMenu(props: {
  readonly mode: SidebarViewMode;
  readonly onModeChange: (mode: SidebarViewMode) => void;
  readonly showEmptySections: boolean;
  readonly onShowEmptySectionsChange: (show: boolean) => void;
  /** Hidden when no connected server can store sections. */
  readonly sectionsAvailable: boolean;
  readonly onNewSection: () => void;
}) {
  const bySection = props.mode === "sections";
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label="View options"
            tooltip={bySection ? "Grouped by section" : "Grouped by status"}
            data-testid="sidebar-view-menu-trigger"
            className="w-auto min-w-8"
          />
        }
      >
        {/* Direct svg children take the header's shared icon size and color. */}
        <ListFilterIcon />
        <ChevronDownIcon aria-hidden className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        <MenuGroup>
          <MenuGroupLabel>Group threads by</MenuGroupLabel>
          <MenuRadioGroup
            value={props.mode}
            onValueChange={(value) => props.onModeChange(value as SidebarViewMode)}
          >
            <MenuRadioItem value="status">
              <span className="flex items-center justify-between gap-3">
                Status
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
            <MenuRadioItem value="sections" disabled={!props.sectionsAvailable}>
              <span className="flex items-center justify-between gap-3">
                Sections
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {props.sectionsAvailable ? (
          <>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={props.showEmptySections}
              disabled={!bySection}
              onCheckedChange={(checked) => props.onShowEmptySectionsChange(checked)}
            >
              Show empty sections
            </MenuCheckboxItem>
            <MenuItem onClick={props.onNewSection}>New section…</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

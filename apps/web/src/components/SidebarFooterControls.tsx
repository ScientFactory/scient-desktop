// FILE: SidebarFooterControls.tsx
// Purpose: Own the production ordering of the sidebar's release note, Activity,
// Settings, and update controls so the app and integration tests use one layout.

import type { ReactNode } from "react";

import { ActivityCenter } from "../notifications/ActivityCenter";
import { WhatsNewSidebarCard } from "../whatsNew/WhatsNewSidebarCard";
import { SidebarFooter, SidebarMenu, SidebarMenuItem } from "./ui/sidebar";

export function SidebarFooterControls({
  beforeReleaseNote,
  settingsAndUpdate,
}: {
  readonly beforeReleaseNote?: ReactNode;
  readonly settingsAndUpdate: ReactNode;
}) {
  return (
    <SidebarFooter className="gap-2 p-2 font-system-ui">
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex flex-col gap-1">
            {beforeReleaseNote}
            <WhatsNewSidebarCard />
            <ActivityCenter />
            {settingsAndUpdate}
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

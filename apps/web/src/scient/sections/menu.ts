import type { ContextMenuItem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** The thread menu's Section entry, which opens the section picker. */
export type SectionMenuId = "section";

export function sectionMenuItem(
  threadCount: number,
  resolve: MessageResolver = m,
): ContextMenuItem<SectionMenuId> {
  return {
    id: "section",
    label:
      threadCount > 1
        ? resolve(msg("Move to section ({count})…", { count: threadCount }))
        : resolve(msg("Move to section…")),
    icon: "list-filter",
  };
}

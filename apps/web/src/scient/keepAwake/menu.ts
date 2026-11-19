import type { ContextMenuItem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export type KeepAwakeMenuId = "keep-awake";

export function keepAwakeMenu(
  chosen: boolean | undefined,
  resolve: MessageResolver = m,
): ContextMenuItem<KeepAwakeMenuId>[] {
  return chosen === undefined
    ? []
    : [
        {
          id: "keep-awake",
          label: resolve(msg("Keep computer awake until done")),
          checked: chosen,
        },
      ];
}

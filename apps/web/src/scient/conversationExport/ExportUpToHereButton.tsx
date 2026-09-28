import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { requestConversationExport } from "./ConversationExportDialog";
import { registeredConversationExportFormats } from "./formatRegistry";

const LABEL = "Export up to here…";

/**
 * A message's "Export up to here…" action: picks the format, then opens the
 * export dialog ending at this message.
 */
export function ExportUpToHereButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly messageId: MessageId;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button type="button" size="xs" variant="ghost" aria-label={LABEL} />}
            />
          }
        >
          <DownloadIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{LABEL}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="top">
        {registeredConversationExportFormats().map((registration) => (
          <MenuItem
            key={registration.format}
            onClick={() =>
              requestConversationExport(props.threadRef, {
                format: registration.format,
                throughMessageId: props.messageId,
              })
            }
          >
            {registration.menuLabel}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

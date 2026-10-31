import { Check, Copy } from "lucide";
import { useRef, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

export function MarkdownTable({ children, dir, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // SCIENT-FORK:START — one direction for the table and its scroll viewport.
  const tableDirection = dir === "rtl" ? "rtl" : "ltr";
  // SCIENT-FORK:END
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<"markdown" | "csv">({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const copyLabel = copied ? "Copied" : "Copy table";

  const handleCopy = (format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyToClipboard(
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table),
      format,
    );
  };

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      // SCIENT-FORK:START — one direction for the table and its scroll viewport.
      dir={tableDirection}
      // SCIENT-FORK:END
    >
      {/* SCIENT-FORK:START — the scroll viewport follows the table's direction. */}
      <ScrollArea
        radius="none"
        chainVerticalScroll
        scrollFade
        className="w-full max-w-full"
        dir={tableDirection}
      >
        <table {...props} dir={tableDirection}>
          {children}
        </table>
      </ScrollArea>
      {/* SCIENT-FORK:END */}
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-end select-none">
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              <MorphIcon className="size-3" icon={copied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

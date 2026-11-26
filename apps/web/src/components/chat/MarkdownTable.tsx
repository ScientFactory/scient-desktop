import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToHtml,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { reportMarkdownActionFailure, type TableCopyFormat } from "./markdownActionFailure";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const TABLE_COPY_SERIALIZERS: Record<TableCopyFormat, (table: Element) => string> = {
  markdown: serializeTableElementToMarkdown,
  csv: serializeTableElementToCsv,
  html: serializeTableElementToHtml,
};

export function MarkdownTable({ children, dir, ...props }: ComponentProps<"table">) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // SCIENT-FORK:START — one direction for the table and its scroll viewport.
  const tableDirection = dir === "rtl" ? "rtl" : "ltr";
  // SCIENT-FORK:END
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const copyLabel = copied ? gt("Copied") : gt("Copy table");

  const handleCopy = (format: TableCopyFormat) => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    const text = TABLE_COPY_SERIALIZERS[format](table);
    // Plain-text targets get the markup; rich targets (mail, docs, wikis) paste a real table.
    copyToClipboard(
      text,
      format,
      format === "html" ? { "text/html": `<meta charset="utf-8">${text}` } : undefined,
      { requireHtml: format === "html" },
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
          <SharedTooltipTrigger
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
            label={copyLabel}
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </SharedTooltipTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>
              <T>Copy as Markdown</T>
            </MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>
              <T>Copy as CSV</T>
            </MenuItem>
            <MenuItem onClick={() => handleCopy("html")}>
              <T>Copy as HTML</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

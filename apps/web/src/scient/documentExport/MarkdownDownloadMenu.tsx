import { Download } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { WordFileExportDialog } from "../wordExport/WordFileExportDialog";
import { documentPdfAvailability } from "./documentPagePdf";
import { savedMarkdownRevision } from "./markdownSavedRevision";
import { useMarkdownPdfExport, type MarkdownPdfExportTarget } from "./MarkdownPdfExportMenuItems";

/**
 * The file header's download button for a Markdown file: the file itself, or
 * the document as PDF or Word.
 */
export function MarkdownDownloadMenu(
  props: MarkdownPdfExportTarget & { readonly onSaveCopy: () => void },
) {
  const exportPdf = useMarkdownPdfExport(props);
  const pdf = documentPdfAvailability();
  const [wordExportOpen, setWordExportOpen] = useState(false);
  return (
    <>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    className="shrink-0"
                    aria-label="Download"
                    variant="ghost"
                    size="icon-sm"
                  />
                }
              />
            }
          >
            <Download className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Download</TooltipPopup>
        </Tooltip>
        {/* As narrow as its three formats, with a little room after them. */}
        <MenuPopup align="end" className="w-max min-w-24">
          <MenuItem onClick={props.onSaveCopy}>Markdown (.md)</MenuItem>
          <MenuItem
            disabled={!pdf.available}
            title={pdf.available ? undefined : pdf.reason}
            onClick={() => void exportPdf()}
          >
            PDF
          </MenuItem>
          <MenuItem onClick={() => setWordExportOpen(true)}>Word (.docx)</MenuItem>
        </MenuPopup>
      </Menu>
      {wordExportOpen ? (
        <WordFileExportDialog
          environmentId={props.environmentId}
          cwd={props.cwd}
          relativePath={props.relativePath}
          savedRevision={() => savedMarkdownRevision(props.persistence)}
          onClose={() => setWordExportOpen(false)}
        />
      ) : null}
    </>
  );
}

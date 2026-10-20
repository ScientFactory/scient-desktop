import { useState } from "react";

import { WordFileExportDialog } from "../wordExport/WordFileExportDialog";
import { DocumentDownloadMenu } from "./DocumentDownloadMenu";
import { documentPdfAvailability } from "./documentPagePdf";
import { savedMarkdownRevision } from "./markdownSavedRevision";
import { useMarkdownPdfExport, type MarkdownPdfExportTarget } from "./MarkdownPdfExportMenuItems";

/** A Markdown file's download button: the file, or the document as PDF or Word. */
export function MarkdownDownloadMenu(
  props: MarkdownPdfExportTarget & { readonly onSaveCopy: () => void },
) {
  const exportPdf = useMarkdownPdfExport(props);
  const pdf = documentPdfAvailability();
  const [wordExportOpen, setWordExportOpen] = useState(false);
  return (
    <>
      <DocumentDownloadMenu
        sourceLabel="Markdown (.md)"
        onSaveCopy={props.onSaveCopy}
        pdf={() => void exportPdf()}
        pdfDisabled={!pdf.available}
        pdfUnavailableReason={pdf.available ? undefined : pdf.reason}
        word={() => setWordExportOpen(true)}
        wordDisabled={false}
      />
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

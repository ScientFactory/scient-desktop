import { FileDown } from "lucide-react";
import { MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { DockCommandItem } from "../writing/dockChrome";

/** Format-specific editors supply the export actions and availability. */
export function DocumentExportMenuItems(props: {
  onPdfExport: () => void;
  onWordExport: () => void;
  pdfDisabled?: boolean;
  wordDisabled?: boolean;
  pdfUnavailableReason?: string;
  pdfLabel?: string;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <FileDown />
        <span>Export</span>
      </MenuSubTrigger>
      <MenuSubPopup className="w-64">
        <DockCommandItem disabled={props.pdfDisabled} onClick={props.onPdfExport}>
          <span className="flex min-w-0 flex-col">
            <span>{props.pdfLabel ?? "PDF"}</span>
            {props.pdfDisabled && props.pdfUnavailableReason ? (
              <span className="text-xs text-muted-foreground">{props.pdfUnavailableReason}</span>
            ) : null}
          </span>
        </DockCommandItem>
        <DockCommandItem disabled={props.wordDisabled} onClick={props.onWordExport}>
          Word
        </DockCommandItem>
      </MenuSubPopup>
    </MenuSub>
  );
}

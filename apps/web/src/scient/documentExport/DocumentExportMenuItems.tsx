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
  /** Without the icon, beside items that have none. */
  plain?: boolean;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        {props.plain ? null : <FileDown />}
        <span>Export</span>
      </MenuSubTrigger>
      {/* As wide as "PDF" and "Word"; the reason a format is unavailable wraps. */}
      <MenuSubPopup className="w-max max-w-60">
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

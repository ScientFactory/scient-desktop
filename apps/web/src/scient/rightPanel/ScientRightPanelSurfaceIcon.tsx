import {
  BookOpenText,
  File,
  FileText,
  Folders,
  Image as ImageIcon,
  LayoutGrid,
  Library,
  Sigma,
} from "lucide-react";

import { OverleafMark } from "../files/ExternalFolderMarks";
import type { ScientRightPanelSurface } from "./surfaces";

/** The project files sign: the Files tab, the Files card and the Show files button. */
export const ScientFilesIcon = Folders;

export function ScientRightPanelSurfaceIcon(props: { readonly surface: ScientRightPanelSurface }) {
  switch (props.surface.module) {
    case "sources":
      return <Library className="size-3 shrink-0" />;
    case "new-tab":
      return <LayoutGrid className="size-3 shrink-0" />;
    case "compute":
      return <Sigma className="size-3 shrink-0" />;
    case "source-pdf":
    case "generated-pdf":
      return <FileText className="size-3 shrink-0" />;
    case "artifact":
      return <ImageIcon className="size-3 shrink-0" />;
    case "file":
      return <File className="size-3 shrink-0" />;
    case "skill":
      return <BookOpenText className="size-3 shrink-0" />;
    case "overleaf-review":
      return <OverleafMark aria-hidden className="size-3 shrink-0" />;
  }
}

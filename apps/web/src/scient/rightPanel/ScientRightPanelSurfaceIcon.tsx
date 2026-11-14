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

import { ComputeLanguageLogo } from "../compute/ComputeLanguageMark";
import { useComputeConsoleStore } from "../compute/computeConsoleStore";
import type { ComputeContextId } from "../compute/computeContextStore";
import { OverleafMark } from "../files/ExternalFolderMarks";
import type { ScientRightPanelSurface } from "./surfaces";

/** The project files sign: the Files tab, the Files card and the Show files button. */
export const ScientFilesIcon = Folders;

/** A Console shows the logo of the language it runs. */
function ComputeSurfaceIcon(props: { readonly contextId: ComputeContextId | undefined }) {
  const languageId = useComputeConsoleStore((state) =>
    props.contextId === undefined ? undefined : state.languages[props.contextId],
  );
  return languageId === undefined ? (
    <Sigma className="size-3 shrink-0" />
  ) : (
    <ComputeLanguageLogo languageId={languageId} className="size-3.5 shrink-0" />
  );
}

export function ScientRightPanelSurfaceIcon(props: { readonly surface: ScientRightPanelSurface }) {
  switch (props.surface.module) {
    case "sources":
      return <Library className="size-3 shrink-0" />;
    case "new-tab":
      return <LayoutGrid className="size-3 shrink-0" />;
    case "compute":
      return <ComputeSurfaceIcon contextId={props.surface.contextId} />;
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

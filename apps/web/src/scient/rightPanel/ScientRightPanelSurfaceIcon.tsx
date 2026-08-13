import { FileText, Library } from "lucide-react";

import type { ScientRightPanelSurface } from "./surfaces";

export function ScientRightPanelSurfaceIcon(props: { readonly surface: ScientRightPanelSurface }) {
  return props.surface.module === "sources" ? (
    <Library className="size-3 shrink-0" />
  ) : (
    <FileText className="size-3 shrink-0" />
  );
}

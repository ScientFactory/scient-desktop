import { useState } from "react";
import type { PdfSourceDescriptor, PdfSourceResolution } from "@scientfactory/document-artifacts";

/** Keep one reader/input lifetime across revision authorization, never across document identity. */
export function useRetainedPdfSource(
  documentKey: string,
  source: PdfSourceDescriptor,
  asset: PdfSourceResolution,
) {
  const [retained, setRetained] = useState<{
    documentKey: string;
    source: PdfSourceDescriptor;
    asset: Extract<PdfSourceResolution, { _tag: "Success" }>;
  } | null>(null);
  if (
    asset._tag === "Success" &&
    (retained?.documentKey !== documentKey || retained.asset.url !== asset.url)
  ) {
    setRetained({ documentKey, source, asset });
  }
  if (asset._tag === "Success") return { source, asset };
  return retained?.documentKey === documentKey ? retained : null;
}

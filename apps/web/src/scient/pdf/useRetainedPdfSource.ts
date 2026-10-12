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
  const authorized = asset._tag === "Success" && asset.waiting !== true;
  if (
    authorized &&
    (retained?.documentKey !== documentKey ||
      retained.source !== source ||
      retained.asset.url !== asset.url)
  ) {
    setRetained({ documentKey, source, asset });
  }
  if (authorized) return { source, asset };
  return retained?.documentKey === documentKey ? retained : null;
}

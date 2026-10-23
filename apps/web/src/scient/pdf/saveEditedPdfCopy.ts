import type { AssetCopyResult } from "@scientfactory/document-artifacts";

import { saveAssetCopyInBrowser } from "../documentArtifacts/browserAssetCopy";

export async function saveEditedPdfCopy(
  bytes: Uint8Array,
  fileName: string,
): Promise<AssetCopyResult> {
  const suggestedFileName = `${fileName.replace(/\.pdf$/iu, "").slice(0, 235)}.pdf`;
  if (window.desktopBridge?.savePdfBytesCopy) {
    return window.desktopBridge.savePdfBytesCopy({ bytes, suggestedFileName });
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
  try {
    return await saveAssetCopyInBrowser({ url, suggestedFileName });
  } finally {
    URL.revokeObjectURL(url);
  }
}

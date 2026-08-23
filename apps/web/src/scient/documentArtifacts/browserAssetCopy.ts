import type { DesktopAssetCopyRequest, DesktopAssetCopyResult } from "@t3tools/contracts";

export async function saveAssetCopyInBrowser(
  request: DesktopAssetCopyRequest,
): Promise<DesktopAssetCopyResult> {
  let response: Response;
  try {
    response = await fetch(request.url, { cache: "no-store" });
  } catch {
    return { _tag: "failed", reason: "network-failed" };
  }
  if (response.status === 409) return { _tag: "failed", reason: "source-changed" };
  if (response.status === 404 || response.status === 410) {
    return { _tag: "failed", reason: "source-unavailable" };
  }
  if (!response.ok) return { _tag: "failed", reason: "network-failed" };

  let objectUrl: string | undefined;
  try {
    objectUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.hidden = true;
    anchor.href = objectUrl;
    anchor.download = request.suggestedFileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    const completedObjectUrl = objectUrl;
    globalThis.setTimeout(() => URL.revokeObjectURL(completedObjectUrl), 1_000);
    objectUrl = undefined;
    return { _tag: "download-started" };
  } catch {
    if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    return { _tag: "failed", reason: "write-failed" };
  }
}

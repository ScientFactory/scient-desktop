export async function copyPngBlobToClipboard(png: Blob): Promise<void> {
  if (png.type.toLowerCase() !== "image/png") {
    throw new Error("Copy image requires an encoded PNG.");
  }

  const desktopCopy =
    typeof window === "undefined" ? undefined : window.desktopBridge?.copyPngToClipboard;
  if (desktopCopy != null) {
    await desktopCopy(new Uint8Array(await png.arrayBuffer()));
    return;
  }

  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write == null) {
    throw new Error("Copy image is unavailable in this environment.");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

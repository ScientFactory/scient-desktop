import jsQR from "jsqr";

/** Largest side a photo is read at: a phone photo of a screen still resolves its QR. */
const READ_SIDE = 1600;

/** The text of the QR code in a photo or screenshot, read on this device; undefined when none. */
export async function readImageQr(image: Blob): Promise<string | undefined> {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, READ_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const context = new OffscreenCanvas(width, height).getContext("2d");
  if (!context) return undefined;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return jsQR(context.getImageData(0, 0, width, height).data, width, height)?.data;
}

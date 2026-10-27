import { isExtensionIconDataUri } from "@t3tools/contracts";

export function extensionIconData(bytes: Uint8Array, contentType?: string) {
  if (!bytes.length || bytes.length > 256 * 1024) return undefined;
  const buffer = Buffer.from(bytes);
  const mime = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? "image/jpeg"
      : buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP"
        ? "image/webp"
        : /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|\/?>)/.test(buffer.toString("utf8").trimStart())
          ? "image/svg+xml"
          : undefined;
  if (!mime || (contentType !== undefined && contentType !== mime)) return undefined;
  const data = `data:${mime};base64,${buffer.toString("base64")}`;
  return isExtensionIconDataUri(data) ? data : undefined;
}

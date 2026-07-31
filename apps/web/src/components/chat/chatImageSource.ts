// FILE: chatImageSource.ts
// Purpose: Central trust boundary for image sources rendered in chat.
// Layer: Web chat presentation policy

import {
  buildLocalImageUrl,
  isLocalImageMarkdownSrc,
  localImageFileName,
} from "~/lib/localImageUrls";

export type SupportedChatImageSource =
  | {
      readonly kind: "attachment";
      readonly previewUrl: string;
      readonly downloadUrl: string;
      readonly name: string;
    }
  | {
      readonly kind: "local";
      readonly previewUrl: string;
      readonly downloadUrl: string;
      readonly name: string;
    }
  | {
      readonly kind: "remote";
      readonly previewUrl: string;
      readonly openUrl: string;
      readonly name: string;
    };

export type ChatImageSource =
  | SupportedChatImageSource
  | {
      readonly kind: "unsupported";
      readonly name: string;
    };

export function chatImageSourceKey(source: ChatImageSource): string {
  return source.kind === "unsupported"
    ? `unsupported:${source.name}`
    : `${source.kind}:${source.previewUrl}`;
}

function hasMalformedPercentEncoding(value: string): boolean {
  try {
    decodeURIComponent(value);
    return false;
  } catch {
    return true;
  }
}

export function resolveAttachmentChatImageSource(input: {
  readonly previewUrl?: string | undefined;
  readonly name: string;
  /** Only live composer/Kanban File objects may opt into their owned blob URL. */
  readonly allowTrustedBlob?: boolean | undefined;
}): ChatImageSource {
  const previewUrl = input.previewUrl?.trim();
  if (!previewUrl) {
    return { kind: "unsupported", name: input.name || "Image" };
  }
  if (hasMalformedPercentEncoding(previewUrl)) {
    return { kind: "unsupported", name: input.name || "Image" };
  }
  const trustedBlob = input.allowTrustedBlob === true && previewUrl.startsWith("blob:");
  const relativeAttachment = previewUrl.startsWith("/attachments/");
  let absoluteAttachment = false;
  try {
    const parsed = new URL(previewUrl);
    absoluteAttachment =
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname.startsWith("/attachments/");
  } catch {
    absoluteAttachment = false;
  }
  if (!trustedBlob && !relativeAttachment && !absoluteAttachment) {
    return { kind: "unsupported", name: input.name || "Image" };
  }
  // Attachment URLs are opaque, server-issued capabilities. Preserve the
  // existing URL exactly instead of reclassifying it as remote content.
  return {
    kind: "attachment",
    previewUrl,
    downloadUrl: previewUrl,
    name: input.name || "Image",
  };
}

export function resolveSafeExternalHttpUrl(src: string): string | null {
  const trimmed = src.trim();
  if (trimmed.startsWith("//") || hasMalformedPercentEncoding(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || !parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function resolveMarkdownChatImageSource(input: {
  readonly src: string;
  readonly alt: string;
  readonly cwd: string | undefined;
}): ChatImageSource {
  const src = input.src.trim();
  const fallbackName = input.alt.trim() || "Chat image";
  if (src.startsWith("//")) {
    return { kind: "unsupported", name: fallbackName };
  }
  if (isLocalImageMarkdownSrc(src)) {
    const name = localImageFileName(src) || fallbackName;
    return {
      kind: "local",
      previewUrl: buildLocalImageUrl({ src, cwd: input.cwd }),
      downloadUrl: buildLocalImageUrl({ src, cwd: input.cwd, download: true }),
      name,
    };
  }
  const remoteUrl = resolveSafeExternalHttpUrl(src);
  if (remoteUrl) {
    return {
      kind: "remote",
      previewUrl: remoteUrl,
      openUrl: remoteUrl,
      name: fallbackName,
    };
  }
  return { kind: "unsupported", name: fallbackName };
}

export function isSupportedChatImageSource(
  source: ChatImageSource,
): source is SupportedChatImageSource {
  return source.kind !== "unsupported";
}

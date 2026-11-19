import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const VERSION_LABELS = {
  accepted: msg("PDF is the accepted manuscript"),
  preprint: msg("PDF is a preprint"),
  unknown: msg("PDF may not be the published version"),
} as const;

/** Said only when no PDF on the source is the published version. */
export function pdfVersionLabel(
  attachments: ReadonlyArray<{
    readonly retrieval?: { readonly version: keyof typeof VERSION_LABELS | "published" };
  }>,
  resolve: MessageResolver = m,
): string {
  const versions = attachments.map((attachment) => attachment.retrieval?.version);
  const [first] = versions;
  if (first === undefined || first === "published") return "";
  if (versions.some((version) => version === undefined || version === "published")) return "";
  return ` · ${resolve(VERSION_LABELS[first])}`;
}

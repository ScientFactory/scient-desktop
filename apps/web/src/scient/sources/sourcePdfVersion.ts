const VERSION_LABELS = {
  accepted: "PDF is the accepted manuscript",
  preprint: "PDF is a preprint",
  unknown: "PDF may not be the published version",
} as const;

/** Said only when no PDF on the source is the published version. */
export function pdfVersionLabel(
  attachments: ReadonlyArray<{
    readonly retrieval?: { readonly version: keyof typeof VERSION_LABELS | "published" };
  }>,
): string {
  const versions = attachments.map((attachment) => attachment.retrieval?.version);
  const [first] = versions;
  if (first === undefined || first === "published") return "";
  if (versions.some((version) => version === undefined || version === "published")) return "";
  return ` · ${VERSION_LABELS[first]}`;
}

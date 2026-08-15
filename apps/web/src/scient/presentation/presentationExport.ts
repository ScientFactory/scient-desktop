export function presentationFileBaseName(title: string | null, fallback: string): string {
  const withoutExtension = title?.replace(/\.[^.]+$/, "") ?? fallback;
  const slug = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function markdownFenceCopySource(
  source: string,
  language: string,
  fenceMeta: string | undefined,
): string {
  const info = [language, fenceMeta?.trim()].filter(Boolean).join(" ");
  const longestRun = [...(source.match(/`{3,}/g) ?? [])].reduce(
    (maximum, run) => Math.max(maximum, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${source.replace(/\n+$/, "")}\n${fence}\n\n`;
}

export function downloadPresentationBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

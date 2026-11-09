const MAX_PNG_DIMENSION = 8_192;
const MAX_PNG_PIXELS = 16_777_216;
const DEFAULT_PNG_SCALE = 2;

/** PNG scale: twice the rendered size, bounded by canvas dimension and pixel limits. */
export function presentationPngScale(width: number, height: number, subject: string): number {
  if (!(width > 0 && height > 0)) {
    throw new Error(`The rendered ${subject} has no measurable size.`);
  }
  return Math.min(
    DEFAULT_PNG_SCALE,
    MAX_PNG_DIMENSION / width,
    MAX_PNG_DIMENSION / height,
    Math.sqrt(MAX_PNG_PIXELS / (width * height)),
  );
}

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

export { downloadBlob as downloadPresentationBlob } from "~/components/preview/staticImageActions";

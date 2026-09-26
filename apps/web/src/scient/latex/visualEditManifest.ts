import { visualCharacters, visualRuns, type VisualRun } from "@t3tools/shared/latexVisual";

export interface VisualEditManifestEntry {
  readonly span: HTMLElement;
  readonly node: Text;
  readonly run: VisualRun;
  readonly sourceCharacterStart: number;
  readonly pdfCharacters: ReturnType<typeof visualCharacters>;
  readonly sourceCharacters: ReturnType<typeof visualCharacters>;
}

export interface VisualEditManifest {
  readonly entries: readonly VisualEditManifestEntry[];
  readonly entryFor: (span: HTMLElement) => VisualEditManifestEntry | null;
  readonly dispose: () => void;
}

interface RenderedSpan {
  readonly span: HTMLElement;
  /** Null spans stay in the sequence as barriers; they can never authorize input. */
  readonly node: Text | null;
  readonly characters: ReturnType<typeof visualCharacters>;
}

interface SourceProjection {
  readonly run: VisualRun;
  readonly characters: ReturnType<typeof visualCharacters>;
}

function textNode(span: HTMLElement): Text | null {
  const node = span.firstChild;
  return node instanceof Text && span.childNodes.length === 1 && span.dir !== "rtl" ? node : null;
}

function occurrenceCount(corpus: string, needle: string): number {
  let count = 0;
  let index = corpus.indexOf(needle);
  while (index >= 0) {
    count += 1;
    if (count > 1) return count;
    index = corpus.indexOf(needle, index + 1);
  }
  return count;
}

function outputCorpus(documentTextItems: readonly string[]): string {
  // PDF.js is free to split one paragraph into arbitrary TextItems. Removing
  // item boundaries makes that segmentation irrelevant to the proof and also
  // catches a second occurrence split differently on another page.
  return documentTextItems.map((item) => visualCharacters(item).text).join("");
}

/**
 * Locate a complete source run in one materialized page.
 *
 * Authorization belongs to the whole run, not to each PDF.js token. Requiring
 * every individual word to be globally unique made ordinary prose such as
 * "the result ... the result" impossible to edit even when the paragraph was
 * unique. A complete, ordered, single-page cover proves the same source splice
 * without mistaking repeated words for ambiguity.
 */
function completeRunEntries(
  page: HTMLElement,
  projection: SourceProjection,
): readonly VisualEditManifestEntry[] | null {
  const spans: RenderedSpan[] = [];
  for (const span of page.querySelectorAll<HTMLElement>(".textLayer span")) {
    const characters = visualCharacters(span.textContent ?? "");
    if (characters.text.length === 0) continue;
    spans.push({ span, node: textNode(span), characters });
  }

  const expected = projection.characters.text;
  const pageCorpus = spans.map((rendered) => rendered.characters.text).join("");
  if (occurrenceCount(pageCorpus, expected) !== 1) return null;
  for (let start = 0; start < spans.length; start += 1) {
    let combined = "";
    const entries: VisualEditManifestEntry[] = [];
    for (let index = start; index < spans.length && combined.length < expected.length; index += 1) {
      const rendered = spans[index]!;
      if (rendered.node === null) break;
      const sourceCharacterStart = combined.length;
      combined += rendered.characters.text;
      if (!expected.startsWith(combined)) break;
      entries.push({
        span: rendered.span,
        node: rendered.node,
        run: projection.run,
        sourceCharacterStart,
        pdfCharacters: rendered.characters,
        sourceCharacters: projection.characters,
      });
      if (combined === expected) return entries;
    }
  }
  return null;
}

/**
 * Build the semantic half of direct editing before the pointer arrives.
 *
 * A run is editable only when its complete normalized text occurs exactly once
 * in the immutable compiled document and exactly one materialized page carries
 * a gap-free cover of it. The PDF stays authoritative visually; this manifest
 * only grants a safe splice of the corresponding literal source run.
 */
export function createVisualEditManifest(
  container: HTMLElement,
  source: string,
  documentTextItems: readonly string[] | null,
): VisualEditManifest {
  const bySpan = new WeakMap<HTMLElement, VisualEditManifestEntry>();
  const entries: VisualEditManifestEntry[] = [];
  const originalAccessibility = new Map<
    HTMLElement,
    Readonly<Record<"tabindex" | "aria-description" | "aria-keyshortcuts", string | null>>
  >();
  if (documentTextItems === null) {
    return { entries, entryFor: () => null, dispose: () => undefined };
  }

  const corpus = outputCorpus(documentTextItems);
  const pages = container.querySelectorAll<HTMLElement>(".page[data-page-number]");
  const covers: Array<readonly VisualEditManifestEntry[]> = [];
  for (const run of visualRuns(source)) {
    const characters = visualCharacters(run.text);
    if (characters.text.length < 3 || occurrenceCount(corpus, characters.text) !== 1) continue;

    let uniqueCover: readonly VisualEditManifestEntry[] | null = null;
    let ambiguous = false;
    for (const page of pages) {
      const cover = completeRunEntries(page, { run, characters });
      if (cover === null) continue;
      if (uniqueCover !== null) {
        ambiguous = true;
        break;
      }
      uniqueCover = cover;
    }
    if (ambiguous || uniqueCover === null) continue;

    covers.push(uniqueCover);
  }

  // A span cannot authorize two source runs. Count before installing so an
  // ambiguity rejects every claimant rather than whichever one arrived last.
  const claims = new Map<HTMLElement, number>();
  for (const cover of covers)
    for (const entry of cover) claims.set(entry.span, (claims.get(entry.span) ?? 0) + 1);

  for (const cover of covers) {
    if (cover.some((entry) => claims.get(entry.span) !== 1)) continue;
    for (const entry of cover) {
      bySpan.set(entry.span, entry);
      entries.push(entry);
      entry.span.classList.add("scient-latex-visual-editable");
      originalAccessibility.set(entry.span, {
        tabindex: entry.span.getAttribute("tabindex"),
        "aria-description": entry.span.getAttribute("aria-description"),
        "aria-keyshortcuts": entry.span.getAttribute("aria-keyshortcuts"),
      });
      entry.span.tabIndex = 0;
      entry.span.setAttribute("aria-description", "Press Enter, Space, or F2 to edit this text");
      entry.span.setAttribute("aria-keyshortcuts", "Enter Space F2");
    }
  }

  return {
    entries,
    entryFor: (span) => bySpan.get(span) ?? null,
    dispose: () => {
      for (const entry of entries) {
        const span = entry.span;
        span.classList.remove("scient-latex-visual-editable");
        const original = originalAccessibility.get(span);
        if (!original) continue;
        for (const [name, value] of Object.entries(original)) {
          if (value === null) span.removeAttribute(name);
          else span.setAttribute(name, value);
        }
      }
    },
  };
}

/** Map a raw PDF text-node offset to the corresponding textarea/source-run offset. */
export function visualManifestOffset(entry: VisualEditManifestEntry, pdfOffset: number): number {
  const normalizedIndex = entry.pdfCharacters.offsets.findIndex((offset) => offset >= pdfOffset);
  const within = normalizedIndex < 0 ? entry.pdfCharacters.text.length : normalizedIndex;
  return (
    entry.sourceCharacters.offsets[entry.sourceCharacterStart + within] ?? entry.run.text.length
  );
}

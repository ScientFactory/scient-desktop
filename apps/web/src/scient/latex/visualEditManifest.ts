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

interface CandidateEntry extends VisualEditManifestEntry {
  readonly page: HTMLElement;
}

interface SourceClaim {
  readonly run: VisualRun;
  readonly sourceCharacterStart: number;
  readonly sourceCharacterEnd: number;
  readonly span: HTMLElement;
}

interface SourceProjection {
  readonly run: VisualRun;
  readonly characters: ReturnType<typeof visualCharacters>;
}

interface UniqueSourceMatch extends SourceProjection {
  readonly start: number;
}

function textNode(span: HTMLElement): Text | null {
  const node = span.firstChild;
  return node instanceof Text && span.childNodes.length === 1 && span.dir !== "rtl" ? node : null;
}

function uniqueSourceMatch(
  runs: readonly SourceProjection[],
  pdfCharacters: ReturnType<typeof visualCharacters>,
): UniqueSourceMatch | null {
  let unique: UniqueSourceMatch | null = null;
  for (const candidate of runs) {
    let index = candidate.characters.text.indexOf(pdfCharacters.text);
    while (index >= 0) {
      if (unique !== null) return null;
      unique = { ...candidate, start: index };
      index = candidate.characters.text.indexOf(pdfCharacters.text, index + 1);
    }
  }
  return unique;
}

function outputOccurrenceCounter(documentTextItems: readonly string[]) {
  // PDF.js is free to split the same visible word into different TextItems on
  // different pages. Removing item boundaries makes that segmentation unable
  // to hide a second occurrence. It may conservatively reject a token formed
  // across unrelated adjacent items, which is the safe direction for source
  // authorization.
  const corpus = documentTextItems.map((item) => visualCharacters(item).text).join("");
  const cache = new Map<string, number>();
  return (needle: string): number => {
    const cached = cache.get(needle);
    if (cached !== undefined) return cached;
    let count = 0;
    let index = corpus.indexOf(needle);
    while (index >= 0) {
      count += 1;
      // Admission only distinguishes exactly one from every other result.
      // Stop early rather than scanning a long document after ambiguity is proven.
      if (count > 1) {
        cache.set(needle, count);
        return count;
      }
      index = corpus.indexOf(needle, index + 1);
    }
    cache.set(needle, count);
    return count;
  };
}

function sourceClaimsWithCollisions(claims: readonly SourceClaim[]): ReadonlySet<HTMLElement> {
  const collisions = new Set<HTMLElement>();
  const byRun = new Map<VisualRun, SourceClaim[]>();
  for (const claim of claims) {
    const grouped = byRun.get(claim.run);
    if (grouped) grouped.push(claim);
    else byRun.set(claim.run, [claim]);
  }
  for (const runClaims of byRun.values()) {
    const ordered = runClaims.toSorted(
      (left, right) =>
        left.sourceCharacterStart - right.sourceCharacterStart ||
        right.sourceCharacterEnd - left.sourceCharacterEnd,
    );
    let furthest: SourceClaim | null = null;
    for (const claim of ordered) {
      if (furthest !== null && claim.sourceCharacterStart < furthest.sourceCharacterEnd) {
        collisions.add(furthest.span);
        collisions.add(claim.span);
      }
      if (furthest === null || claim.sourceCharacterEnd > furthest.sourceCharacterEnd) {
        furthest = claim;
      }
    }
  }
  return collisions;
}

/**
 * The editor replaces one complete source run with one textarea. Its admitted
 * PDF spans therefore have to form one ordered, gap-free cover of that run on
 * one page. A merely unique fragment is enough to locate source, but it is not
 * enough to prove that the textarea will mask every glyph it replaces.
 */
function completelyCoveredRun(entries: readonly CandidateEntry[]): boolean {
  const first = entries[0];
  if (!first) return false;
  let expectedStart = 0;
  for (const entry of entries) {
    if (
      entry.page !== first.page ||
      entry.run !== first.run ||
      entry.sourceCharacters !== first.sourceCharacters ||
      entry.sourceCharacterStart !== expectedStart
    )
      return false;
    expectedStart += entry.pdfCharacters.text.length;
  }
  return expectedStart === first.sourceCharacters.text.length;
}

/**
 * Build the semantic half of direct editing before the pointer arrives.
 *
 * A PDF text token is editable only when its normalized contents occur exactly
 * once in both the bounded source projection and the complete compiled PDF text
 * stream. Rendered spans must also claim disjoint source intervals. The PDF stays
 * authoritative visually; this manifest only grants a safe source splice.
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
  const runs = visualRuns(source).map((run) => ({
    run,
    characters: visualCharacters(run.text),
  }));
  const outputOccurrences =
    documentTextItems === null ? null : outputOccurrenceCounter(documentTextItems);
  const claims: SourceClaim[] = [];
  const candidates: CandidateEntry[] = [];

  for (const span of container.querySelectorAll<HTMLElement>(
    ".page[data-page-number] .textLayer span",
  )) {
    const renderedText = span.textContent ?? "";
    const pdfCharacters = visualCharacters(renderedText);
    if (pdfCharacters.text.length === 0) continue;
    const unique = uniqueSourceMatch(runs, pdfCharacters);
    if (unique === null) continue;

    const sourceCharacterEnd = unique.start + pdfCharacters.text.length;
    claims.push({
      run: unique.run,
      sourceCharacterStart: unique.start,
      sourceCharacterEnd,
      span,
    });

    const node = textNode(span);
    if (
      node === null ||
      pdfCharacters.text.length < 3 ||
      outputOccurrences === null ||
      outputOccurrences(pdfCharacters.text) !== 1
    )
      continue;

    const page = span.closest<HTMLElement>(".page[data-page-number]");
    if (!page) continue;
    const entry: CandidateEntry = {
      span,
      node,
      run: unique.run,
      sourceCharacterStart: unique.start,
      pdfCharacters,
      sourceCharacters: unique.characters,
      page,
    };
    candidates.push(entry);
  }

  const collisions = sourceClaimsWithCollisions(claims);
  const candidatesByRun = new Map<VisualRun, CandidateEntry[]>();
  for (const candidate of candidates) {
    if (collisions.has(candidate.span)) continue;
    const grouped = candidatesByRun.get(candidate.run);
    if (grouped) grouped.push(candidate);
    else candidatesByRun.set(candidate.run, [candidate]);
  }

  for (const runCandidates of candidatesByRun.values()) {
    if (!completelyCoveredRun(runCandidates)) continue;
    for (const candidate of runCandidates) {
      const { page: _page, ...entry } = candidate;
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

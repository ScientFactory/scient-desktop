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

function textNode(span: HTMLElement): Text | null {
  const node = span.firstChild;
  return node instanceof Text && span.childNodes.length === 1 && span.dir !== "rtl" ? node : null;
}

/**
 * Build the semantic half of direct editing before the pointer arrives.
 *
 * A PDF text token is editable only when its normalized contents occur exactly
 * once in the bounded literal-prose projection of the compiled source. The PDF
 * stays authoritative visually; this manifest only grants a safe source splice.
 */
export function createVisualEditManifest(
  container: HTMLElement,
  source: string,
): VisualEditManifest {
  const bySpan = new WeakMap<HTMLElement, VisualEditManifestEntry>();
  const entries: VisualEditManifestEntry[] = [];
  const runs = visualRuns(source).map((run) => ({
    run,
    characters: visualCharacters(run.text),
  }));

  for (const span of container.querySelectorAll<HTMLElement>(
    ".page[data-page-number] .textLayer span",
  )) {
    const node = textNode(span);
    if (!node) continue;
    const pdfCharacters = visualCharacters(node.data);
    if (pdfCharacters.text.length < 3) continue;

    let unique: {
      run: VisualRun;
      characters: ReturnType<typeof visualCharacters>;
      start: number;
    } | null = null;
    let ambiguous = false;
    for (const candidate of runs) {
      let index = candidate.characters.text.indexOf(pdfCharacters.text);
      while (index >= 0) {
        if (unique !== null) {
          ambiguous = true;
          break;
        }
        unique = { run: candidate.run, characters: candidate.characters, start: index };
        index = candidate.characters.text.indexOf(pdfCharacters.text, index + 1);
      }
      if (ambiguous) break;
    }
    if (ambiguous || unique === null) continue;

    const entry: VisualEditManifestEntry = {
      span,
      node,
      run: unique.run,
      sourceCharacterStart: unique.start,
      pdfCharacters,
      sourceCharacters: unique.characters,
    };
    bySpan.set(span, entry);
    entries.push(entry);
    span.classList.add("scient-latex-visual-editable");
  }

  return {
    entries,
    entryFor: (span) => bySpan.get(span) ?? null,
    dispose: () => {
      for (const entry of entries) entry.span.classList.remove("scient-latex-visual-editable");
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

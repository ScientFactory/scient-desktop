import type { Node as ProseMirrorNode } from "prosemirror-model";

export interface ScientMarkdownFootnoteEntry {
  readonly definitionPosition: number | null;
  readonly label: string;
  readonly number: number | null;
  readonly referencePositions: readonly number[];
}

export type ScientMarkdownFootnotePresentation = ReadonlyMap<string, ScientMarkdownFootnoteEntry>;

interface MutableFootnoteEntry {
  definitionPosition: number | null;
  readonly label: string;
  number: number | null;
  readonly referencePositions: number[];
}

/** Derive stable source labels and reader-facing numbers without rewriting Markdown. */
export function scientMarkdownFootnotePresentation(
  document: ProseMirrorNode,
): ScientMarkdownFootnotePresentation {
  const entries = new Map<string, MutableFootnoteEntry>();
  let nextNumber = 1;
  const entryFor = (label: string) => {
    const existing = entries.get(label);
    if (existing) return existing;
    const entry: MutableFootnoteEntry = {
      definitionPosition: null,
      label,
      number: null,
      referencePositions: [],
    };
    entries.set(label, entry);
    return entry;
  };

  document.descendants((node, position) => {
    if (node.type.name === "footnote_reference") {
      const entry = entryFor(String(node.attrs.label));
      if (entry.number === null) {
        entry.number = nextNumber;
        nextNumber += 1;
      }
      entry.referencePositions.push(position);
    } else if (node.type.name === "footnote_definition") {
      const entry = entryFor(String(node.attrs.label));
      entry.definitionPosition ??= position;
    }
  });

  return new Map(
    [...entries].map(([label, entry]) => [
      label,
      {
        definitionPosition: entry.definitionPosition,
        label: entry.label,
        number: entry.number,
        referencePositions: [...entry.referencePositions],
      },
    ]),
  );
}

export function nextScientMarkdownFootnoteLabel(document: ProseMirrorNode): string {
  const used = new Set(scientMarkdownFootnotePresentation(document).keys());
  let sequence = 1;
  while (used.has(`note-${sequence}`)) sequence += 1;
  return `note-${sequence}`;
}

export function scientMarkdownFootnoteDefinitionId(label: string): string {
  return `scient-footnote-${encodeURIComponent(label)}`;
}

export function scientMarkdownFootnoteReferenceId(label: string, occurrence: number): string {
  return `${scientMarkdownFootnoteDefinitionId(label)}-reference-${occurrence}`;
}

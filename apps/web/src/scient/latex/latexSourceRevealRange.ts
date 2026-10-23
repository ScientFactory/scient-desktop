import { sourceOffset } from "../math/input/sourceAdapter";

/** A verified Visual range or a word anchored to SyncTeX's mapped source line. */
export function latexSourceRevealRange(
  source: string,
  reveal: {
    readonly source?: string;
    readonly from?: number;
    readonly to?: number;
    readonly precise?: boolean;
    readonly line?: number;
    readonly column?: number | null;
    readonly selectedText?: string;
  },
) {
  if (reveal.source !== undefined && reveal.source !== source) return null;
  if (
    reveal.precise &&
    reveal.from !== undefined &&
    reveal.to !== undefined &&
    reveal.from >= 0 &&
    reveal.to >= reveal.from &&
    reveal.to <= source.length
  )
    return { from: reveal.from, to: reveal.to };
  const line =
    reveal.line ??
    (reveal.from !== undefined ? source.slice(0, reveal.from).split("\n").length : null);
  if (line === null || line < 1) return null;
  const text = source.split(/\r\n|[\r\n]/u)[line - 1];
  if (text === undefined) return null;
  const start = sourceOffset(source, { line: line - 1, character: 0 });
  const word = reveal.selectedText?.trim();
  if (word) {
    const matches: number[] = [];
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) matches.push(at);
    const at =
      matches.length === 1
        ? matches[0]
        : reveal.column != null
          ? matches.find(
              (offset) => offset <= reveal.column! && offset + word.length >= reveal.column!,
            )
          : undefined;
    if (at !== undefined) return { from: start + at, to: start + at + word.length };
  }
  return { from: start, to: start + text.length };
}

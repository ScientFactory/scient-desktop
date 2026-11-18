import type { ComputeResultResolution } from "@t3tools/contracts";

/**
 * Manuscript references to linked results: `[0.72](scient-result:<revision>/values.json#/hr)` for a
 * value and `[![alt](assets/results/km-<revision>.png)](scient-result:<revision>/km.png)` for a
 * figure. Both are ordinary Markdown, so any other renderer shows the value or the image.
 */
export const RESULT_PROTOCOL = "scient-result:";
export const RESULTS_FOLDER_VARIABLE = "SCIENT_RESULTS_DIR";

const REVISION = /^r[0-9a-z]{12}$/u;
const MAX_TARGET_LENGTH = 4096;

export interface ResultTarget {
  readonly revision: string;
  /** POSIX path inside the revision's results folder. */
  readonly output: string;
  /** JSON Pointer to a value; null for a whole file such as a figure. */
  readonly pointer: string | null;
}

// Parentheses would end the Markdown link destination, so they are encoded too.
const encodeSegment = (segment: string) =>
  encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29");
const encodePath = (path: string) => path.split("/").map(encodeSegment).join("/");

export function formatResultTarget(target: ResultTarget): string {
  const pointer =
    target.pointer === null ? "" : `#${target.pointer.split("/").map(encodeSegment).join("/")}`;
  return `${RESULT_PROTOCOL}${target.revision}/${encodePath(target.output)}${pointer}`;
}

export function parseResultTarget(href: string): ResultTarget | null {
  if (!href.startsWith(RESULT_PROTOCOL) || href.length > MAX_TARGET_LENGTH) return null;
  const body = href.slice(RESULT_PROTOCOL.length);
  const hash = body.indexOf("#");
  const path = hash < 0 ? body : body.slice(0, hash);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const revision = path.slice(0, slash);
  if (!REVISION.test(revision)) return null;
  try {
    const segments = path
      .slice(slash + 1)
      .split("/")
      .map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
      return null;
    const pointer =
      hash < 0
        ? null
        : body
            .slice(hash + 1)
            .split("/")
            .map((segment) => decodeURIComponent(segment))
            .join("/");
    if (pointer !== null && !pointer.startsWith("/")) return null;
    return { revision, output: segments.join("/"), pointer };
  } catch {
    return null;
  }
}

/** JSON Pointer (RFC 6901) for one object key path. */
export function resultPointer(keys: ReadonlyArray<string>): string {
  return keys.map((key) => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function pointerKeys(pointer: string): ReadonlyArray<string> {
  return pointer
    .slice(1)
    .split("/")
    .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
}

const MARKDOWN_LABEL_SPECIAL = /[\\[\]*_`<>^]/gu;

export function escapeMarkdownLabel(text: string): string {
  return text.replace(MARKDOWN_LABEL_SPECIAL, (character) => `\\${character}`);
}

/** CommonMark backslash escapes: a backslash before ASCII punctuation is dropped. */
export function unescapeMarkdownLabel(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/gu, "$1");
}

const formatDestination = (src: string) => (/[\s()<>]/u.test(src) ? `<${src}>` : src);

export function formatResultValueMarkdown(value: string, target: ResultTarget): string {
  return `[${escapeMarkdownLabel(value)}](${formatResultTarget(target)})`;
}

export function formatResultFigureMarkdown(
  input: { readonly alt: string; readonly src: string },
  target: ResultTarget,
): string {
  return `[![${escapeMarkdownLabel(input.alt)}](${formatDestination(input.src)})](${formatResultTarget(target)})`;
}

export type MarkdownResultReference = ResultTarget &
  (
    | { readonly kind: "value"; readonly text: string }
    | { readonly kind: "figure"; readonly alt: string; readonly src: string }
    /** A table's caption link; the table itself is the block before the caption. */
    | { readonly kind: "table"; readonly caption: string }
  ) & { readonly start: number; readonly end: number };

/**
 * A caption to start from: `event-rates.png` → `Event rates`. A name such as `table1` says nothing
 * a numbered caption does not, so those name the script instead: `Results of analysis.py`.
 */
export function resultCaption(output: string, scriptPath: string): string {
  const words = (output.split("/").at(-1) ?? output)
    .replace(/\.[^.]+$/u, "")
    .replace(/[-_]+/gu, " ")
    .replace(/(?<=[a-z])(?=[0-9])/gu, " ")
    .trim();
  if (words === "" || /^(?:table|tab|fig|figure|plot|chart)\s*\d*$/iu.test(words))
    return `Results of ${scriptPath.split("/").at(-1) ?? scriptPath}`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Tables are linked from their caption, `Table: [Table 1](scient-result:<revision>/table1.csv)`. */
export const isResultTableOutput = (output: string) => /\.csv$/iu.test(output);

export function formatResultTableCaption(caption: string, target: ResultTarget): string {
  return `Table: [${escapeMarkdownLabel(caption)}](${formatResultTarget(target)})`;
}

const FIGURE_LABEL = /^!\[((?:\\.|[^\\\]])*)\]\(\s*(<[^>\n]*>|[^\s)]*)(?:\s+"[^"]*")?\s*\)$/su;

/** Every result reference in Markdown source, outside fenced code. */
export function findMarkdownResultReferences(
  source: string,
): ReadonlyArray<MarkdownResultReference> {
  const references: MarkdownResultReference[] = [];
  const fenced = fencedRanges(source);
  const opener = `](${RESULT_PROTOCOL}`;
  for (let at = source.indexOf(opener); at >= 0; at = source.indexOf(opener, at + 1)) {
    if (fenced.some(([from, to]) => at >= from && at < to)) continue;
    const close = source.indexOf(")", at + 2);
    if (close < 0) break;
    const target = parseResultTarget(source.slice(at + 2, close));
    if (target === null) continue;
    const open = labelStart(source, at);
    if (open < 0) continue;
    const label = source.slice(open + 1, at);
    const figure = FIGURE_LABEL.exec(label);
    references.push(
      !figure && target.pointer === null && isResultTableOutput(target.output)
        ? {
            ...target,
            kind: "table",
            caption: unescapeMarkdownLabel(label),
            start: open,
            end: close + 1,
          }
        : figure
          ? {
              ...target,
              kind: "figure",
              alt: unescapeMarkdownLabel(figure[1] ?? ""),
              src: (figure[2] ?? "").replace(/^<|>$/gu, ""),
              start: open,
              end: close + 1,
            }
          : {
              ...target,
              kind: "value",
              text: unescapeMarkdownLabel(label),
              start: open,
              end: close + 1,
            },
    );
  }
  return references;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1)
    backslashes += 1;
  return backslashes % 2 === 1;
}

/** The `[` that opens the label ending at `end`, matching nested brackets. */
function labelStart(source: string, end: number): number {
  let depth = 0;
  for (let cursor = end - 1; cursor >= 0; cursor -= 1) {
    const character = source[cursor];
    if (character === "\n" && source[cursor - 1] === "\n") return -1;
    if ((character !== "[" && character !== "]") || isEscaped(source, cursor)) continue;
    if (character === "]") depth += 1;
    else if (depth === 0) return cursor;
    else depth -= 1;
  }
  return -1;
}

function fencedRanges(source: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gmu;
  let open: { readonly marker: string; readonly at: number } | null = null;
  for (const match of source.matchAll(fence)) {
    const marker = match[1] ?? "";
    if (open === null) open = { marker, at: match.index };
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) {
      ranges.push([open.at, match.index + match[0].length]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open.at, source.length]);
  return ranges;
}

type JsonLeaf = { readonly pointer: string; readonly value: string };

const MAX_VALUES = 500;
const MAX_VALUE_LENGTH = 2000;

/**
 * Strings and numbers in a values file, numbers as their literal text so `0.720` stays `0.720`.
 * Null when the text is not JSON.
 */
export function readResultValues(text: string): ReadonlyArray<JsonLeaf> | null {
  let root: unknown;
  try {
    root = JSON.parse(text, (_key, value, context?: { readonly source?: string }) =>
      typeof value === "number" && typeof context?.source === "string"
        ? new LiteralNumber(context.source)
        : value,
    );
  } catch {
    return null;
  }
  const leaves: JsonLeaf[] = [];
  const visit = (node: unknown, keys: ReadonlyArray<string>) => {
    if (leaves.length >= MAX_VALUES) return;
    if (typeof node === "string" || node instanceof LiteralNumber) {
      const value = typeof node === "string" ? node : node.source;
      // A value reads inline in a sentence; a line break would split the paragraph.
      if (keys.length > 0 && value.length <= MAX_VALUE_LENGTH && !/[\r\n]/u.test(value))
        leaves.push({ pointer: resultPointer(keys), value });
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Array.isArray(node)
      ? node.map((child, index) => [String(index), child] as const)
      : Object.entries(node))
      visit(child, [...keys, key]);
  };
  visit(root, []);
  return leaves;
}

export function resultValueAt(text: string, pointer: string): string | null {
  const keys = JSON.stringify(pointerKeys(pointer));
  return (
    readResultValues(text)?.find((leaf) => JSON.stringify(pointerKeys(leaf.pointer)) === keys)
      ?.value ?? null
  );
}

/** What the reader must act on first; a figure counts as present when the revision has it. */
export type ResultReferenceState =
  | "current"
  | "newer"
  | "stale"
  | "edited"
  | "missing"
  | "unrecorded";

const sameRows = (
  left: ReadonlyArray<ReadonlyArray<string>>,
  right: ReadonlyArray<ReadonlyArray<string>>,
) =>
  left.length === right.length &&
  left.every(
    (row, index) =>
      row.length === right[index]!.length &&
      row.every((cell, column) => cell === right[index]![column]),
  );

export function resultReferenceState(
  reference:
    | { readonly kind: "value"; readonly text: string }
    | { readonly kind: "figure" }
    /** Null rows when the caller cannot read the table, so only its run is compared. */
    | { readonly kind: "table"; readonly rows: ReadonlyArray<ReadonlyArray<string>> | null },
  resolution: ComputeResultResolution | undefined,
): ResultReferenceState {
  if (resolution === undefined || resolution._tag === "unrecorded") return "unrecorded";
  const present =
    reference.kind === "value"
      ? resolution.value !== null
      : reference.kind === "figure"
        ? resolution.figure
        : resolution.table != null;
  if (!present) return "missing";
  if (resolution.summary.causes.length > 0) return "stale";
  if (reference.kind === "value" && reference.text !== resolution.value) return "edited";
  if (
    reference.kind === "table" &&
    reference.rows !== null &&
    resolution.table != null &&
    !sameRows(reference.rows, resolution.table)
  )
    return "edited";
  if (resultHasNewer(reference, resolution)) return "newer";
  return "current";
}

export function resultHasNewer(
  reference: { readonly kind: "value" | "figure" | "table" },
  resolution: Extract<ComputeResultResolution, { readonly _tag: "resolved" }>,
): boolean {
  const newer = resolution.newer;
  if (newer === null) return false;
  return reference.kind === "figure"
    ? newer.figure
    : reference.kind === "table"
      ? newer.table != null
      : newer.value !== null;
}

class LiteralNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}

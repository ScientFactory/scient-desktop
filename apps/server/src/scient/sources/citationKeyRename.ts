import { markdownProseTextSpans } from "@scientfactory/scient-markdown";
import { parse } from "@unified-latex/unified-latex-util-parse";

type LatexNode = {
  readonly type?: unknown;
  readonly content?: unknown;
  readonly args?: ReadonlyArray<{ readonly content: unknown }>;
  readonly position?: { readonly start: { readonly offset: number } };
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function renameInMarkdown(text: string, from: string, to: string): string {
  // A key follows the start, space, `[`, `;`, `(` or `-`; an e-mail address does not.
  const pattern = new RegExp(
    `(?<=^|[\\s\\[;(-])@${escapeRegExp(from)}(?![\\p{L}\\p{N}_]|[:.#-][\\p{L}\\p{N}_])`,
    "gu",
  );
  // Prose only: code, math, links, URLs, HTML and front matter keep their text.
  const spans = markdownProseTextSpans(text);
  const inProse = (start: number, end: number) =>
    spans.some((span) => span.start <= start && end <= span.end);
  return text.replace(pattern, (match, offset: number) =>
    inProse(offset, offset + match.length) ? `@${to}` : match,
  );
}

const LATEX_CITE_ARGUMENTS = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/uy;

/** Where the parser found `\cite`-family commands; comments and verbatim text have none. */
function latexCiteOffsets(text: string): ReadonlyArray<number> {
  const offsets: number[] = [];
  const visit = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const candidate of nodes as ReadonlyArray<unknown>) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const node = candidate as LatexNode;
      if (
        node.type === "macro" &&
        typeof node.content === "string" &&
        /cite/iu.test(node.content) &&
        node.position
      ) {
        offsets.push(node.position.start.offset);
      }
      visit(node.content);
      for (const arg of node.args ?? []) visit(arg.content);
    }
  };
  visit(parse(text).content);
  return offsets.toSorted((left, right) => left - right);
}

function renameInLatex(text: string, from: string, to: string): string {
  let next = "";
  let copied = 0;
  for (const offset of latexCiteOffsets(text)) {
    if (offset < copied) continue;
    LATEX_CITE_ARGUMENTS.lastIndex = offset;
    const match = LATEX_CITE_ARGUMENTS.exec(text);
    if (!match) continue;
    const keysStart = offset + match[0].length - 1 - match[1]!.length;
    const items = match[1]!.split(",");
    if (!items.some((item) => item.trim() === from)) continue;
    const renamed = items.map((item) => (item.trim() === from ? item.replace(from, to) : item));
    next += `${text.slice(copied, keysStart)}${renamed.join(",")}`;
    copied = keysStart + match[1]!.length;
  }
  return copied === 0 ? text : next + text.slice(copied);
}

/**
 * Renames a citation key where a document cites it, using each format's
 * parser: `[@key]` and `@key` in Markdown prose, the key lists of
 * `\cite`-family commands in LaTeX. Every other byte stays as written.
 */
export function renameCitationKeyInDocument(
  kind: "markdown" | "latex",
  text: string,
  from: string,
  to: string,
): string {
  return kind === "latex" ? renameInLatex(text, from, to) : renameInMarkdown(text, from, to);
}

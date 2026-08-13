import { useMemo } from "react";

// Same fence split ChatMarkdown uses, so a half-streamed fence still counts as code.
const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;
const INLINE_CODE_SPAN_PATTERN = /(`[^`\n]+`)/;
// `\[...\]` before `\(...\)`, non-greedy, and never on an escaped `\\(` opener.
const TEX_DELIMITER_PATTERN = /(?<!\\)\\\[([\s\S]*?)\\\]|(?<!\\)\\\(([\s\S]*?)\\\)/g;

/** Drops the blank edges of the expression and keeps every line inside `indent`. */
function displayBlockBody(tex: string, indent: string): string {
  const lines = tex.split("\n");
  const [firstLine] = lines;
  // Only the opener's own line lost its indentation to the `$$` replacing it;
  // later lines already carry the indentation of the block they sit in.
  if (firstLine !== undefined && firstLine.trim() !== "") {
    lines[0] = indent + firstLine.trim();
  }
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  return lines.join("\n");
}

/**
 * remark-math only opens a display block when `$$` starts its own line, so math
 * that already stands alone becomes a fenced block and math embedded in a
 * sentence stays on one line, where remark-math reads it as inline math.
 */
function displayDollars(text: string, index: number, length: number, tex: string): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const indent = text.slice(lineStart, index);
  const lineEnd = text.indexOf("\n", index + length);
  const trailing = text.slice(index + length, lineEnd === -1 ? undefined : lineEnd);
  if (indent.trim() !== "" || trailing.trim() !== "") {
    return `$$${tex.trim()}$$`;
  }
  // The opening fence inherits the indentation already copied from the source.
  return `$$\n${displayBlockBody(tex, indent)}\n${indent}$$`;
}

function rewriteDelimiters(text: string): string {
  let rewritten = "";
  let lastIndex = 0;
  for (const match of text.matchAll(TEX_DELIMITER_PATTERN)) {
    const [matched, displayTex, inlineTex] = match;
    rewritten += text.slice(lastIndex, match.index);
    rewritten +=
      inlineTex === undefined
        ? displayDollars(text, match.index, matched.length, displayTex ?? "")
        : `$${inlineTex.trim()}$`;
    lastIndex = match.index + matched.length;
  }
  return rewritten + text.slice(lastIndex);
}

/** Rewrites the TeX delimiters models emit into the dollar forms remark-math parses. */
export function normalizeScientMathDelimiters(text: string): string {
  if (!text.includes("\\[") && !text.includes("\\(")) {
    return text;
  }

  const fenceSegments = text.split(FENCED_CODE_SEGMENT_PATTERN);
  for (let index = 0; index < fenceSegments.length; index += 2) {
    const codeSpanSegments = (fenceSegments[index] ?? "").split(INLINE_CODE_SPAN_PATTERN);
    for (let spanIndex = 0; spanIndex < codeSpanSegments.length; spanIndex += 2) {
      codeSpanSegments[spanIndex] = rewriteDelimiters(codeSpanSegments[spanIndex] ?? "");
    }
    fenceSegments[index] = codeSpanSegments.join("");
  }
  return fenceSegments.join("");
}

/** Memoized per message text, since streaming re-renders the same string repeatedly. */
export function useScientMathMarkdownText(text: string, enabled: boolean): string {
  return useMemo(() => (enabled ? normalizeScientMathDelimiters(text) : text), [enabled, text]);
}

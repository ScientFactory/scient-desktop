import { FileCitation, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { sourceOffset } from "../math/input/sourceAdapter";

export type SourceCitationTarget = ScopedThreadRef & {
  cwd: string;
  path: string;
  latexRootRelativePath?: string | undefined;
};
const revisions = new Map<string, string>();
export function sourceCitationRevision(source: string) {
  const existing = revisions.get(source);
  if (existing) return existing;
  const revision = `sha256:${bytesToHex(sha256(new TextEncoder().encode(source)))}`;
  if (revisions.size >= 4) revisions.delete(revisions.keys().next().value!);
  revisions.set(source, revision);
  return revision;
}

export function createSourceCitation(
  target: SourceCitationTarget,
  source: string,
  baseline: string,
  from: number,
  to: number,
): FileCitation | null {
  if (from < 0 || to <= from || to > source.length) return null;
  const text = source.slice(from, to);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
    return null;
  const citation = {
    kind: "file" as const,
    version: 1 as const,
    environmentId: target.environmentId,
    threadId: target.threadId,
    cwd: target.cwd,
    path: target.path,
    ...(target.latexRootRelativePath
      ? {
          latex: {
            rootRelativePath: target.latexRootRelativePath,
            sourceHash: sourceCitationRevision(text),
          },
        }
      : {}),
    sourceSelection: true as const,
    revision: sourceCitationRevision(source),
    origin: source === baseline ? ("saved" as const) : ("draft" as const),
    sourceStart: from,
    sourceEnd: to,
    from,
    to,
    startLine: source.slice(0, from).split(/\r\n|[\r\n]/u).length,
    endLine: source.slice(0, to - 1).split(/\r\n|[\r\n]/u).length,
    text,
    prefix: [...source.slice(Math.max(0, from - 33), from)].slice(-16).join(""),
    suffix: [...source.slice(to, to + 33)].slice(0, 16).join(""),
  };
  return Schema.is(FileCitation)(citation) ? citation : null;
}

export function resolveSourceCitation(source: string, citation: FileCitation) {
  if (!citation.sourceSelection) return null;
  if (sourceCitationRevision(source) === citation.revision)
    return source.slice(citation.sourceStart, citation.sourceEnd) === citation.text
      ? { from: citation.sourceStart, to: citation.sourceEnd }
      : null;
  let match: { from: number; to: number } | null = null;
  for (
    let from = source.indexOf(citation.text);
    from >= 0;
    from = source.indexOf(citation.text, from + 1)
  ) {
    const to = from + citation.text.length;
    if (
      source.slice(Math.max(0, from - citation.prefix.length), from) !== citation.prefix ||
      source.slice(to, to + citation.suffix.length) !== citation.suffix
    )
      continue;
    if (match) return null;
    match = { from, to };
  }
  return match;
}

/** Pierre's rendered rows are virtualized; only measure rows whose text matches the model. */
export function sourceCitationRects(root: HTMLElement, source: string, from: number, to: number) {
  const roots: (HTMLElement | ShadowRoot)[] = [root];
  for (let i = 0; i < roots.length; i++)
    for (const element of roots[i]!.querySelectorAll("*"))
      if (element.shadowRoot) roots.push(element.shadowRoot);
  const lines = source.split(/\r\n|[\r\n]/u);
  const starts = [0];
  for (const match of source.matchAll(/\r\n|[\r\n]/gu)) starts.push(match.index + match[0].length);
  const rects: DOMRect[] = [];
  for (const part of roots)
    for (const row of part.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
      const line = Number(row.dataset.line) - 1;
      const start = starts[line];
      const text = lines[line];
      if (
        start === undefined ||
        text === undefined ||
        row.textContent?.replace(/\r?\n$/u, "") !== text
      )
        continue;
      const lo = Math.max(0, from - start),
        hi = Math.min(text.length, to - start);
      if (hi <= lo) continue;
      const walker = root.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const range = root.ownerDocument.createRange();
      let offset = 0,
        first = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const end = offset + (node.textContent?.length ?? 0);
        if (!first && lo < end) {
          range.setStart(node, lo - offset);
          first = true;
        }
        if (first && hi <= end) {
          range.setEnd(node, hi - offset);
          rects.push(...range.getClientRects());
          break;
        }
        offset = end;
      }
    }
  return rects;
}

export function staticSourceSelection(root: HTMLElement, source: string) {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const shadows = [...root.querySelectorAll("*")].flatMap((element) =>
    element.shadowRoot ? [element.shadowRoot] : [],
  );
  const composed = (
    selection as Selection & {
      getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
    }
  ).getComposedRanges?.({ shadowRoots: shadows });
  const range = composed?.[0] ?? (selection.rangeCount === 1 ? selection.getRangeAt(0) : null);
  if (!range) return null;
  const offset = (node: Node, at: number) => {
    const row = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      "[data-content] > [data-line]",
    );
    if (!row) return null;
    const host = row.getRootNode();
    if (!(host instanceof ShadowRoot ? root.contains(host.host) : root.contains(row))) return null;
    const prefix = root.ownerDocument.createRange();
    prefix.selectNodeContents(row);
    prefix.setEnd(node, at);
    const line = Number(row.dataset.line) - 1;
    const text = source.split(/\r\n|[\r\n]/u)[line];
    if (text === undefined || row.textContent?.replace(/\r?\n$/u, "") !== text) return null;
    return sourceOffset(source, { line, character: prefix.toString().length });
  };
  const from = offset(range.startContainer, range.startOffset),
    to = offset(range.endContainer, range.endOffset);
  return from !== null && to !== null && to > from ? { from, to } : null;
}

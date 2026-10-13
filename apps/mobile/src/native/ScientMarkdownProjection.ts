import type { Root, RootContent } from "mdast";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";
import {
  resolveMarkdownInlineCodePresentation,
  resolveMarkdownLinkPresentation,
} from "../lib/markdownLinks";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "../lib/enrichedLinkPresentation";

/** The existing Markdown owner's single parser, HTML projection and bounded decoder. */
export interface ScientNativeMarkdownSourceTools {
  parse(source: string): Root;
  withHtml(source: string): string;
  decodeEntities(value: string): string;
}

export interface ScientNativeMarkdownProjectionResult {
  linkSources: Array<{ url: string; source: string | null }>;
  recognizedLinkTextByUrl: Record<string, string>;
  markdown: string;
}

type MarkdownNode = Root | RootContent;

/** Bind once to the existing source owners; native display and Copy never alter stored text. */
export function createScientNativeMarkdownProjection(sourceTools: ScientNativeMarkdownSourceTools) {
  function projectNativeFileMentions(source: string) {
    const edits: Array<{ start: number; end: number; source: string; replacement: string }> = [];
    const visit = (node: MarkdownNode, insideLink = false) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      // Parsed text offsets are safe only when Markdown escapes have not changed that text.
      if (
        node.type === "text" &&
        !insideLink &&
        start !== undefined &&
        end !== undefined &&
        source.slice(start, end) === node.value
      ) {
        for (const token of collectComposerInlineTokens(`${node.value} `)) {
          if (token.type !== "mention" || !token.source.startsWith("@")) continue;
          const path = token.source.startsWith('@"')
            ? token.value
            : token.value.replace(/[.,;!?]+$/, "");
          const presentation = resolveMarkdownLinkPresentation(path);
          if (presentation.kind !== "file") continue;
          const tokenEnd = token.end - (token.value.length - path.length);
          const label = presentation.label.replace(/[\\[\]]/g, "\\$&");
          const destination = presentation.href.replace(/</g, "%3C").replace(/>/g, "%3E");
          edits.push({
            start: start + token.start,
            end: start + tokenEnd,
            source: node.value.slice(token.start, tokenEnd),
            replacement: `[${label}](<${destination}>)`,
          });
        }
      }
      if ("children" in node) {
        const linked = insideLink || node.type === "link" || node.type === "linkReference";
        node.children.forEach((child) => visit(child, linked));
      }
    };
    visit(sourceTools.parse(source));
    const sources = new Map<number, string>();
    let delta = 0;
    for (const edit of edits) {
      sources.set(edit.start + delta, edit.source);
      delta += edit.replacement.length - (edit.end - edit.start);
    }
    return {
      sources,
      markdown: edits
        .reverse()
        .reduce(
          (result, edit) => result.slice(0, edit.start) + edit.replacement + result.slice(edit.end),
          source,
        ),
    };
  }

  /** Preserve native reader links and occurrence-specific default Copy without changing stored text. */
  function nativeMarkdownProjection(source: string): ScientNativeMarkdownProjectionResult {
    const mentions = projectNativeFileMentions(sourceTools.withHtml(source));
    const markdown = mentions.markdown;
    const root = sourceTools.parse(markdown);
    const definitions = new Map<string, string>();
    const collectDefinitions = (node: MarkdownNode) => {
      if (node.type === "definition" && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
      if ("children" in node) node.children.forEach(collectDefinitions);
    };
    collectDefinitions(root);
    const links: Array<{ url: string; source: string | null }> = [];
    const recognizedLinkTextByUrl: Record<string, string> = {};
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    const normalizeTextEntities = (start: number, end: number) => {
      const written = markdown.slice(start, end);
      for (const entity of written.matchAll(/&(?:amp;)*(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi)) {
        let escapes = 0;
        for (let index = entity.index - 1; index >= 0 && written[index] === "\\"; index -= 1)
          escapes += 1;
        if (escapes % 2 !== 0) continue;
        const decoded = sourceTools.decodeEntities(sourceTools.decodeEntities(entity[0]));
        edits.push({
          start: start + entity.index,
          end: start + entity.index + entity[0].length,
          replacement: /^[\t\r\n]$/.test(decoded)
            ? `&#${decoded.codePointAt(0)};`
            : (decoded === "\0" ? entity[0] : decoded).replace(/[!-/:-@\[-`{-~]/g, "\\$&"),
        });
      }
    };
    const visit = (node: MarkdownNode) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        (node.type === "link" || node.type === "linkReference") &&
        start !== undefined &&
        end !== undefined
      ) {
        const url = node.type === "link" ? node.url : definitions.get(node.identifier);
        if (url !== undefined) {
          const written = markdown.slice(start, end);
          const labelEnd =
            node.type === "link" ? written.lastIndexOf("](") : written.lastIndexOf("][");
          const label = labelEnd < 0 ? written.slice(1, -1) : written.slice(1, labelEnd);
          links.push({
            url,
            source: parseMarkdownFileLink(url)
              ? (mentions.sources.get(start) ??
                (node.type === "link" ? written : `[${label}](<${url.replace(/&/g, "\\&")}>)`))
              : null,
          });
          if (
            node.type === "link" &&
            !written.startsWith("[") &&
            /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(written)
          ) {
            // Autolink child text shares its destination source. Give that literal
            // label its own span before decoding, preserving mdast's raw URL.
            const rawLabel =
              written.startsWith("<") && written.endsWith(">") ? written.slice(1, -1) : written;
            const literalLabel = rawLabel
              .replace(/&(?:amp;)*(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity) => {
                const decoded = sourceTools.decodeEntities(sourceTools.decodeEntities(entity));
                return decoded === "\0" ? entity : decoded;
              })
              .replace(/[!-/:-@\[-`{-~]/g, "\\$&")
              .replace(/[\t\r\n]/g, (control) => `&#${control.codePointAt(0)};`);
            edits.push({
              start,
              end,
              replacement: `[${literalLabel}](<${url.replace(/[\\&<>]/g, "\\$&")}>)`,
            });
            return;
          }
        }
      }
      if (node.type === "inlineCode" && ENRICHED_INLINE_FILE_LINK_REGEX.test(node.value)) {
        const presentation = resolveMarkdownInlineCodePresentation(node.value);
        if (presentation?.kind === "file") {
          recognizedLinkTextByUrl[node.value] = `[${presentation.label}](<${presentation.href}>)`;
        }
      }
      // md4c's native text callback omits entity nodes. Preserve the retired reader's
      // bounded decoding as literal text, after capturing original file-link source.
      if (node.type === "text" && start !== undefined && end !== undefined) {
        normalizeTextEntities(start, end);
      }
      if (
        (node.type === "paragraph" ||
          node.type === "heading" ||
          node.type === "strong" ||
          node.type === "emphasis" ||
          node.type === "delete") &&
        start !== undefined &&
        end !== undefined
      ) {
        const missing = node.children.filter(
          (child) =>
            child.position?.start.offset === undefined || child.position?.end.offset === undefined,
        );
        if (
          missing.length > 0 &&
          missing.every((child) => child.type === "text" || child.type === "link")
        ) {
          // GFM's literal-autolink transform can replace text with offset-free children.
          // Only the parent's uncovered text belongs here; protect every positioned
          // child subtree so labels, destinations, titles, HTML and code stay owned.
          const protectedRanges = node.children
            .flatMap((child) => {
              const left = child.position?.start.offset;
              const right = child.position?.end.offset;
              return left !== undefined && right !== undefined ? [{ start: left, end: right }] : [];
            })
            .sort((left, right) => left.start - right.start);
          let cursor = start;
          for (const range of protectedRanges) {
            if (range.start > cursor) normalizeTextEntities(cursor, Math.min(range.start, end));
            cursor = Math.max(cursor, range.end);
          }
          if (cursor < end) normalizeTextEntities(cursor, end);
        }
      }
      if (
        (node.type === "link" || node.type === "image" || node.type === "definition") &&
        start !== undefined &&
        end !== undefined
      ) {
        const written = markdown.slice(start, end);
        const marker = node.type === "definition" ? "]:" : "](";
        // Link child positions end at the authored label, before any destination punctuation.
        const childEnd =
          node.type === "link" ? node.children.at(-1)?.position?.end.offset : undefined;
        let labelEnd = childEnd === undefined ? 0 : childEnd - start;
        if (childEnd === undefined) {
          let depth = 0;
          for (let index = written.indexOf("["); index >= 0 && index < written.length; index += 1) {
            if (written[index] === "\\") {
              index += 1;
              continue;
            }
            if (written[index] === "[") depth += 1;
            if (written[index] === "]" && --depth === 0) {
              labelEnd = index;
              break;
            }
          }
        }
        const markerStart = written.indexOf(marker, labelEnd);
        const markerEnd = markerStart + marker.length;
        const whitespace = /^[ \t\r\n]*/.exec(written.slice(markerEnd))?.[0].length ?? 0;
        const destination = markerEnd + whitespace;
        const wrapped = written[destination] === "<";
        const contentStart = destination + (wrapped ? 1 : 0);
        let contentEnd = contentStart;
        let depth = 0;
        for (; contentEnd < written.length; contentEnd += 1) {
          const character = written[contentEnd];
          if (character === "\\") {
            contentEnd += 1;
            continue;
          }
          if (wrapped && character === ">") break;
          if (!wrapped) {
            if (/\s/.test(character!)) break;
            if (character === "(") depth += 1;
            if (character === ")") {
              if (depth === 0) break;
              depth -= 1;
            }
          }
        }
        const rawDestination = written.slice(contentStart, contentEnd);
        if (markerStart >= 0 && /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(rawDestination)) {
          // Remark decodes destination entities once. Escape literal ampersands so
          // md4c's raw MD_ATTRIBUTE text retains that exact identity, even &amp; names.
          const literal = node.url.replace(/[\\&<>]/g, "\\$&");
          edits.push({
            start: start + destination,
            end: start + contentEnd + (wrapped ? 1 : 0),
            replacement: `<${literal}>`,
          });
        } else if (
          markerStart >= 0 &&
          isWindowsAbsolutePath(node.url) &&
          node.url.includes("\\") &&
          rawDestination === node.url
        ) {
          edits.push({
            start: start + contentStart,
            end: start + contentEnd,
            replacement: node.url.replaceAll("\\", "\\\\"),
          });
        }
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(root);
    return {
      linkSources: links,
      recognizedLinkTextByUrl,
      markdown: edits
        .sort((left, right) => right.start - left.start)
        .reduce(
          (result, edit) => result.slice(0, edit.start) + edit.replacement + result.slice(edit.end),
          markdown,
        ),
    };
  }

  return nativeMarkdownProjection;
}

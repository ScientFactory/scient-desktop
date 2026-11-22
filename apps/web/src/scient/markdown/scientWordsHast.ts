/**
 * Scient's passes on the chat hast Words builds (markdown/wordsHast.ts mounts them): Scient's math
 * grammar, its image cards, its content direction in place of T3's per-block direction, and inert
 * rich fences.
 */
import type { Element, ElementContent, Root } from "hast";

import type { ContentDirection, FixedContentDirection } from "../bidi/contentDirection";
import { rehypeScientBidi } from "../bidi/rehypeScientBidi";
import { scientWordsMath, type ScientWordsMath } from "../math/scientWordsMath";
import { resolveScientRichFenceKind } from "../presentation/scientRichFenceKind";

/** What a chat message adds to Words' options. Part of the renderer's cache key. */
export interface ScientWordsHastOptions {
  /** Render math with Scient's grammar and KaTeX instead of Words' SVG. */
  readonly math: boolean;
  /** The message's resolved direction. */
  readonly contentDirection: FixedContentDirection;
  /** The user's setting, so an explicit mode stays authoritative for lists and tables. */
  readonly requestedContentDirection?: ContentDirection | undefined;
}

/** A cache key for the options, so equal messages share one options object and its renderer. */
export function scientWordsOptionsKey(options: ScientWordsHastOptions | undefined): string {
  return options
    ? `\u0000${+options.math}\u0000${options.contentDirection}\u0000${options.requestedContentDirection}`
    : "";
}

/** Scient's math for one render, or null when the message renders without it. */
export function scientWordsHastMath(
  options: ScientWordsHastOptions | undefined,
): ScientWordsMath | null {
  return options?.math ? scientWordsMath() : null;
}

/**
 * Marks a standalone figure for Scient's image card: an image alone in its paragraph, outside a
 * table, without an authored size or paragraph alignment.
 */
function markScientImageCards(node: Root | Element, inTableCell: boolean) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "img") {
      child.properties.dataScientImageCard =
        !inTableCell &&
        node.type === "element" &&
        node.tagName === "p" &&
        !node.properties.align &&
        !child.properties.width &&
        !child.properties.height &&
        node.children.every(
          (sibling) => sibling === child || (sibling.type === "text" && !sibling.value.trim()),
        );
    }
    markScientImageCards(child, inTableCell || child.tagName === "td" || child.tagName === "th");
  }
}

/** Inline code keeps left-to-right inside right-to-left prose; code blocks keep their own frame. */
function isolateInlineCode(node: Root | Element) {
  for (const child of node.children) {
    if (child.type !== "element" || child.tagName === "pre") continue;
    if (child.tagName === "code") child.properties.dir = "ltr";
    else isolateInlineCode(child);
  }
}

/** Image cards and the message's content direction, after T3's own passes. */
export function scientChatHast(tree: Root, options: ScientWordsHastOptions | undefined) {
  markScientImageCards(tree, false);
  const requestedDirection = options?.requestedContentDirection;
  rehypeScientBidi({
    direction: options?.contentDirection ?? "ltr",
    ...(requestedDirection ? { requestedDirection } : {}),
  })(tree as never);
  isolateInlineCode(tree);
}

/** A notebook cell never loads URLs or acts: a link shows its text and an image its alt text. */
export function scientNotebookInert(node: Root | Element) {
  const children = node.children as ElementContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type !== "element") continue;
    if (child.tagName === "a") {
      children.splice(index, 1, ...child.children);
      index--;
      continue;
    }
    if (child.tagName === "img") {
      children[index] = { type: "text", value: String(child.properties.alt ?? "") };
      continue;
    }
    scientNotebookInert(child);
  }
}

/** Inert Markdown shows every rich fence (Mermaid, Plotly, Vega) as its source. */
export function scientInertRichFences(node: Root | Element) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const className = child.properties.className;
    if (child.tagName === "code" && Array.isArray(className)) {
      const language = className
        .map(String)
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length);
      if (language !== undefined && resolveScientRichFenceKind(language) !== null) {
        child.properties.className = ["language-text"];
      }
    }
    scientInertRichFences(child);
  }
}

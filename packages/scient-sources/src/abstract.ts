import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import type { ScientSourceAbstractSection } from "./model.ts";

type AbstractNode = DefaultTreeAdapterMap["node"];
type AbstractElement = DefaultTreeAdapterMap["element"];
type AbstractText = DefaultTreeAdapterMap["textNode"];

const OMIT_CONTENT_ELEMENTS = new Set(["script", "style", "template"]);
const BLOCK_CONTENT_ELEMENTS = new Set(["abstract", "article", "body", "div", "section", "sec"]);

export interface ScientSourceAbstractDocument {
  readonly text: string;
  readonly sections: ReadonlyArray<ScientSourceAbstractSection>;
}

type AbstractEvent =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string };
type MutableAbstractSection = { title: string | null; paragraphs: string[] };

function elementName(element: AbstractElement): string {
  const name = element.tagName.toLowerCase();
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function isElement(node: AbstractNode): node is AbstractElement {
  return "tagName" in node;
}

function isText(node: AbstractNode): node is AbstractText {
  return node.nodeName === "#text" && "value" in node;
}

function normalizeInlineText(value: string): string | null {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function collectInlineText(node: AbstractNode, parts: string[]): void {
  if (isText(node)) {
    parts.push(node.value);
    return;
  }
  if (!isElement(node) && !("childNodes" in node)) return;
  if (isElement(node) && OMIT_CONTENT_ELEMENTS.has(elementName(node))) return;
  for (const child of node.childNodes) collectInlineText(child, parts);
}

function inlineText(node: AbstractNode): string | null {
  const parts: string[] = [];
  collectInlineText(node, parts);
  return normalizeInlineText(parts.join(""));
}

function normalizePlainParagraphs(value: string): string[] {
  return value
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map((paragraph) => normalizeInlineText(paragraph))
    .filter((paragraph): paragraph is string => paragraph !== null);
}

/**
 * Provider HTML is not consistently block-wrapped. Europe PMC, for example,
 * can return `<h4>Methods</h4>Body text` with the body as a bare sibling text
 * node. Accumulate those loose nodes across inline markup and flush them only
 * at semantic block boundaries so no scholarly text is discarded or split.
 */
function collectSemanticEvents(root: AbstractNode, events: AbstractEvent[]): void {
  let looseText: string[] = [];
  const flushLooseText = () => {
    const paragraphs = normalizePlainParagraphs(looseText.join(""));
    looseText = [];
    for (const text of paragraphs) events.push({ kind: "paragraph", text });
  };

  const visit = (node: AbstractNode): void => {
    if (isText(node)) {
      looseText.push(node.value);
      return;
    }
    if (!isElement(node) && !("childNodes" in node)) return;
    if (isElement(node)) {
      const name = elementName(node);
      if (OMIT_CONTENT_ELEMENTS.has(name)) return;
      if (name === "title" || /^h[1-6]$/u.test(name)) {
        flushLooseText();
        const text = inlineText(node);
        if (text) events.push({ kind: "heading", text });
        return;
      }
      if (name === "p" || name === "li" || name === "list-item") {
        flushLooseText();
        const text = inlineText(node);
        if (text) events.push({ kind: "paragraph", text });
        return;
      }
      if (name === "br") {
        flushLooseText();
        return;
      }

      const block = BLOCK_CONTENT_ELEMENTS.has(name);
      if (block) flushLooseText();
      for (const child of node.childNodes) visit(child);
      if (block) flushLooseText();
      return;
    }
    for (const child of node.childNodes) visit(child);
  };

  visit(root);
  flushLooseText();
}

function sectionsFromEvents(events: ReadonlyArray<AbstractEvent>): MutableAbstractSection[] {
  const sections: MutableAbstractSection[] = [];
  for (const event of events) {
    if (event.kind === "heading") {
      sections.push({ title: event.text, paragraphs: [] });
      continue;
    }
    const current = sections.at(-1);
    if (current) current.paragraphs.push(event.text);
    else sections.push({ title: null, paragraphs: [event.text] });
  }
  return sections.filter((section) => section.title !== null || section.paragraphs.length > 0);
}

function withoutRedundantAbstractHeading(
  sections: ReadonlyArray<MutableAbstractSection>,
): MutableAbstractSection[] {
  const [first, ...rest] = sections;
  if (!first || first.title?.toLowerCase() !== "abstract") return [...sections];
  if (first.paragraphs.length === 0) return rest;
  return [{ title: null, paragraphs: first.paragraphs }, ...rest];
}

export function abstractDocumentFromSections(
  input: ReadonlyArray<ScientSourceAbstractSection> | null | undefined,
): ScientSourceAbstractDocument | null {
  const sections = withoutRedundantAbstractHeading(
    (input ?? []).flatMap((section) => {
      const title = normalizeInlineText(section.title ?? "");
      const paragraphs = section.paragraphs.flatMap((paragraph) => {
        const normalized = normalizeInlineText(paragraph);
        return normalized ? [normalized] : [];
      });
      return title || paragraphs.length > 0 ? [{ title, paragraphs }] : [];
    }),
  ).filter((section) => section.paragraphs.length > 0);
  const text = sections
    .flatMap((section) => [section.title, ...section.paragraphs].filter(Boolean))
    .join("\n\n");
  return text ? { text, sections } : null;
}

/**
 * Converts provider-specific abstract markup into Scient's canonical abstract
 * document. Only explicit source markup becomes a heading; plain text is never
 * heuristically promoted based on its length or wording.
 */
export function normalizeScientSourceAbstractDocument(
  value: string | null | undefined,
): ScientSourceAbstractDocument | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const fragment = parseFragment(trimmed);
  const events: AbstractEvent[] = [];
  collectSemanticEvents(fragment, events);
  if (events.length > 0) return abstractDocumentFromSections(sectionsFromEvents(events));

  const plainText = inlineText(fragment);
  if (!plainText) return null;
  return abstractDocumentFromSections([
    { title: null, paragraphs: normalizePlainParagraphs(trimmed) },
  ]);
}

export function normalizeScientSourceAbstract(value: string | null | undefined): string | null {
  return normalizeScientSourceAbstractDocument(value)?.text ?? null;
}

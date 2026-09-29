import type { JSONContent } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

/** Classify editor operations only. No source parsing, serialization or TeX checks. */
export function isOrdinaryTyping(transaction: Transaction): boolean {
  if (!transaction.steps.length) return false;
  return transaction.steps.every((step, index) => {
    if (!(step instanceof ReplaceStep)) return false;
    const doc = transaction.docs[index]!;
    const from = doc.resolve(step.from);
    const to = doc.resolve(step.to);
    if (
      !from.sameParent(to) ||
      !["paragraph", "heading"].includes(from.parent.type.name) ||
      step.slice.openStart !== 0 ||
      step.slice.openEnd !== 0
    )
      return false;
    let textOnly = true;
    from.parent.nodesBetween(from.parentOffset, to.parentOffset, (node: DocumentNode) => {
      if (!node.isText) textOnly = false;
      return textOnly;
    });
    step.slice.content.forEach((node) => {
      if (!node.isText) textOnly = false;
    });
    return textOnly;
  });
}

interface TypingDraft {
  baseSource: string;
  content: JSONContent;
}
const keyFor = (key: string) => `scient:latex-visual-draft:typing:${key}`;

export function readTypingDraft(key: string): TypingDraft | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(keyFor(key)) ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("baseSource" in value) ||
      typeof value.baseSource !== "string" ||
      !("content" in value) ||
      !value.content ||
      typeof value.content !== "object" ||
      !("type" in value.content) ||
      value.content.type !== "doc"
    )
      return null;
    return { baseSource: value.baseSource, content: value.content as JSONContent };
  } catch {
    return null;
  }
}

/** Used after paint or on exit, never on the ordinary input path. */
export function retainTypingDraft(key: string, baseSource: string, doc: DocumentNode): void {
  try {
    localStorage.setItem(keyFor(key), JSON.stringify({ baseSource, content: doc.toJSON() }));
  } catch {
    window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
  }
}

export function clearTypingDraft(key: string): void {
  try {
    localStorage.removeItem(keyFor(key));
  } catch {
    /* The live editor and normal source recovery remain available. */
  }
}

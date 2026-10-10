import type { JSONContent } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { serializedVisualDocument } from "./visualDocumentJson";

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

/** Reuse the projection's editing capabilities; inspect only the changed text slot. */
export function isSourceOwnedTyping(
  transaction: Transaction,
  editableBlock: (index: number) => boolean,
): boolean {
  if (!isOrdinaryTyping(transaction)) return false;
  return transaction.steps.every((step, index) => {
    if (!(step instanceof ReplaceStep)) return false;
    const from = transaction.docs[index]!.resolve(step.from);
    if (!editableBlock(from.index(0))) return false;
    for (let depth = 1; depth <= from.depth; depth++)
      if (from.node(depth).attrs.editable === false) return false;
    // New formatting needs its own capability/package check. Continuing an
    // existing style needs only escaping and patching its text argument.
    const marks = from.marks();
    let existingStyle = true;
    step.slice.content.forEach((node) => {
      if (node.marks.some((mark) => !marks.some((existing) => existing.eq(mark))))
        existingStyle = false;
    });
    return existingStyle;
  });
}

interface TypingDraft {
  baseSource: string;
  content: JSONContent;
}
const keyFor = (key: string) => `scient:latex-visual-draft:typing:${key}`;

export function readTypingDraft(key: string): TypingDraft | null {
  try {
    return parseTypingDraft(localStorage.getItem(keyFor(key)) ?? "null");
  } catch {
    return null;
  }
}

/** Decode one stored snapshot; null when it is not a usable one. */
export function parseTypingDraft(stored: string): TypingDraft | null {
  try {
    const value: unknown = JSON.parse(stored);
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

/**
 * Used after paint or on exit, never on the ordinary input path. Returns the
 * identity of the snapshot it stored, so the writer can later remove exactly
 * that version; null when nothing was stored.
 */
export function retainTypingDraft(
  key: string,
  baseSource: string,
  doc: DocumentNode,
  previousIdentity: string | null = null,
): string | null {
  const stored = `{"baseSource":${JSON.stringify(baseSource)},"content":${serializedVisualDocument(doc)}}`;
  try {
    const occupant = localStorage.getItem(keyFor(key));
    if (occupant !== null && occupant !== previousIdentity && occupant !== stored) {
      // Another window may own the only durable copy of this writing.
      window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
      return null;
    }
    localStorage.setItem(keyFor(key), stored);
    return stored;
  } catch {
    window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
    return null;
  }
}

/** The stored snapshot exactly as written; identifies one version of it. */
export function typingDraftIdentity(key: string): string | null {
  try {
    return localStorage.getItem(keyFor(key));
  } catch {
    return null;
  }
}

/** Remove the snapshot only if it is still the version the caller saw. */
export function discardTypingDraft(key: string, identity: string): boolean {
  try {
    if (localStorage.getItem(keyFor(key)) !== identity) return false;
    localStorage.removeItem(keyFor(key));
    return true;
  } catch {
    window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
    return false;
  }
}

export function clearTypingDraft(key: string): void {
  try {
    localStorage.removeItem(keyFor(key));
  } catch {
    /* The live editor and normal source recovery remain available. */
  }
}

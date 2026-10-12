import type { JSONContent } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { serializedVisualDocument } from "./visualDocumentJson";
import { latexVisualNodeSignature, projectLatexVisualDocument } from "./latexVisualDocument";

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

function visualNodeOrigin(node: JSONContent): string | number | null {
  if (node.type === "listItem")
    return typeof node.attrs?.sourceMeta?.from === "number" ? node.attrs.sourceMeta.from : null;
  return typeof node.attrs?.sourceId === "string" ? node.attrs.sourceId : null;
}

/** Enter may consume whitespace, but every surviving inline token must agree. */
function matchesItemFragments(original: JSONContent, fragments: readonly JSONContent[]): boolean {
  if (fragments.length === 1)
    return latexVisualNodeSignature(original) === latexVisualNodeSignature(fragments[0]!);
  if (
    original.content?.length !== 1 ||
    original.content[0]?.type !== "paragraph" ||
    fragments.some((item) => item.content?.length !== 1 || item.content[0]?.type !== "paragraph")
  )
    return false;
  const units = (paragraph: JSONContent): JSONContent[] =>
    (paragraph.content ?? []).flatMap((node) =>
      node.type === "text" ? Array.from(node.text ?? "", (text) => ({ ...node, text })) : [node],
    );
  const previous = units(original.content[0]);
  let at = 0;
  for (const item of fragments) {
    const paragraph = item.content![0]!;
    if (
      latexVisualNodeSignature({ ...original.content[0], content: [] }) !==
      latexVisualNodeSignature({ ...paragraph, content: [] })
    )
      return false;
    for (const node of units(paragraph)) {
      const key = latexVisualNodeSignature(node);
      while (
        previous[at]?.type === "text" &&
        /^\s+$/u.test(previous[at]!.text ?? "") &&
        latexVisualNodeSignature(previous[at]!) !== key
      )
        at++;
      if (!previous[at] || latexVisualNodeSignature(previous[at++]!) !== key) return false;
    }
  }
  return previous.slice(at).every((node) => node.type === "text" && /^\s*$/u.test(node.text ?? ""));
}

/** Live edits keep their item origin; recovered splits must prove their correspondence. */
function listItemOrigins(
  content: JSONContent,
  before: JSONContent,
  live: boolean,
): number[] | null {
  const proposed = content.content ?? [];
  const original = before.content ?? [];
  const groups = new Map<number, { items: JSONContent[]; indexes: number[] }>();
  for (const [index, item] of proposed.entries()) {
    const hint = visualNodeOrigin(item);
    if (typeof hint !== "number" || !Number.isSafeInteger(hint)) return null;
    let group = groups.get(hint);
    if (!group) {
      group = { items: [], indexes: [] };
      groups.set(hint, group);
    }
    group.items.push(item);
    group.indexes.push(index);
  }
  const result: number[] = [];
  const used = new Set<number>();
  for (const [hint, group] of groups) {
    // A live transaction already identifies its item, even when text repeats.
    // Only recovered input needs to rediscover ownership from its semantics.
    let owner = live ? original.findIndex((item) => visualNodeOrigin(item) === hint) : -1;
    if (!live)
      for (const [index, item] of original.entries()) {
        if (!matchesItemFragments(item, group.items)) continue;
        if (owner !== -1) return null;
        owner = index;
      }
    if (owner === -1 || used.has(owner)) return null;
    used.add(owner);
    for (const index of group.indexes) result[index] = owner;
  }
  return result;
}

function detachedTableSourceMeta(node: JSONContent): unknown {
  if (
    node.type !== "latexRichPreview" ||
    node.attrs?.kind !== "table" ||
    node.attrs.sourceId != null ||
    typeof node.attrs.raw !== "string"
  )
    return undefined;
  // The retained raw seed is authored input, not a native document range.
  // Reparse only the supported single table and borrow its internal syntax map.
  const seed = projectLatexVisualDocument(node.attrs.raw).content.content;
  const table = seed?.length === 1 ? seed[0] : undefined;
  return table?.type === node.type &&
    table.attrs?.kind === "table" &&
    table.attrs.editable === true &&
    table.attrs.raw === node.attrs.raw
    ? table.attrs.sourceMeta
    : undefined;
}

/**
 * Rebind syntax trivia to the current projection without changing authored
 * content. Split origins must agree with surviving semantic evidence; return
 * null on ambiguous recovery so the caller retains the authored input visibly.
 */
export function rebindVisualTypingContent(
  content: JSONContent,
  baseline: JSONContent,
  before?: JSONContent,
): JSONContent | null {
  if (content === baseline) return content;
  // A live insertion has no earlier/native counterpart to rebind. Its detached
  // parser facts describe the newly authored raw block, not an existing owner.
  // Keep those in memory so table/description serializers can admit the edit;
  // recovery persistence still removes sourceMeta through authoredAttributes.
  if (
    before &&
    !before.type &&
    !baseline.type &&
    content.attrs?.sourceId == null &&
    content.attrs?.sourceMeta != null
  )
    return content;
  const list = content.type === "bulletList" || content.type === "orderedList";
  const baselineList = baseline.type === "bulletList" || baseline.type === "orderedList";
  const originalItems = before ?? baseline;
  const splitOrigins =
    list && baselineList && content.content?.length !== originalItems.content?.length
      ? listItemOrigins(content, originalItems, before !== undefined)
      : undefined;
  if (
    splitOrigins === null ||
    (splitOrigins && originalItems.content?.length !== baseline.content?.length)
  )
    return null;
  if (
    splitOrigins?.some(
      (index) =>
        latexVisualNodeSignature(originalItems.content![index]!) !==
        latexVisualNodeSignature(baseline.content![index]!),
    )
  )
    return null;
  const detachedTable =
    content.type === "latexRichPreview" &&
    content.attrs?.kind === "table" &&
    content.attrs.sourceId == null;
  const sameOwner =
    (content.type === baseline.type ||
      (list && baselineList) ||
      (before?.type !== undefined && before.type === baseline.type)) &&
    (!detachedTable ||
      (baseline.attrs?.kind === "table" && baseline.attrs.raw === content.attrs?.raw));
  const sourceId = sameOwner ? baseline.attrs?.sourceId : undefined;
  const sourceMeta = sameOwner ? baseline.attrs?.sourceMeta : detachedTableSourceMeta(content);
  const changedAttrs =
    content.attrs?.sourceId !== sourceId || content.attrs?.sourceMeta !== sourceMeta;
  let attrs = content.attrs;
  if (changedAttrs) {
    attrs = { ...attrs };
    delete attrs.sourceId;
    delete attrs.sourceMeta;
    if (sourceId !== undefined) attrs.sourceId = sourceId;
    if (sourceMeta !== undefined) attrs.sourceMeta = sourceMeta;
  }
  let children: JSONContent[] | undefined;
  let origins: Map<string | number, number> | undefined;
  for (const [index, node] of (content.content ?? []).entries()) {
    let originalIndex = splitOrigins?.[index] ?? index;
    if (before && !list && (node.type === "listItem" || (node.attrs && "sourceId" in node.attrs))) {
      const key = visualNodeOrigin(node);
      if (key === null) originalIndex = -1;
      else if (visualNodeOrigin(before.content?.[index] ?? {}) !== key) {
        if (!origins) {
          origins = new Map();
          before.content?.forEach((item, at) => {
            const owner = visualNodeOrigin(item);
            if (owner !== null && !origins!.has(owner)) origins!.set(owner, at);
          });
        }
        originalIndex = origins.get(key) ?? -1;
      }
    }
    if (originalIndex < 0 && sameOwner) originalIndex = baseline.content?.indexOf(node) ?? -1;
    const rebound = rebindVisualTypingContent(
      node,
      sameOwner ? (baseline.content?.[originalIndex] ?? {}) : {},
      before ? (before.content?.[originalIndex] ?? {}) : undefined,
    );
    if (!rebound) return null;
    if (rebound === node) continue;
    children ??= content.content!.slice();
    children[index] = rebound;
  }
  if (!changedAttrs && !children) return content;
  return {
    ...content,
    ...(changedAttrs ? { attrs } : {}),
    ...(children ? { content: children } : {}),
  };
}

/**
 * Carry only changes authored after the canvas baseline into a canonical
 * native projection. Repeated appearances may have changed behind untouched
 * canvas blocks; those are not requests to revert the native source.
 */
export function reconcileVisualPendingContent(
  content: JSONContent,
  before: JSONContent,
  native: JSONContent,
): JSONContent | null {
  const original = before.content ?? [];
  const current = native.content ?? [];
  if (original.length !== current.length) return null;
  let owners: Map<string, number> | undefined;
  let children: JSONContent[] | undefined;
  const proposed = content.content ?? [];
  for (let index = 0; index < proposed.length; index++) {
    const node = proposed[index]!;
    const id = node.attrs?.sourceId;
    let at = index;
    if (node !== original[at] && typeof id === "string" && original[at]?.attrs?.sourceId !== id) {
      if (!owners) {
        owners = new Map();
        original.forEach((item, position) => {
          const owner = item.attrs?.sourceId;
          if (typeof owner === "string") owners!.set(owner, position);
        });
      }
      at = owners.get(id) ?? -1;
    } else if (
      node !== original[at] &&
      typeof id !== "string" &&
      original.length !== proposed.length
    ) {
      at = original.indexOf(node);
    }
    const previous = original[at];
    if (!previous) continue;
    const canonical = current[at]!;
    const unchanged =
      node === previous || latexVisualNodeSignature(node) === latexVisualNodeSignature(previous);
    if (!unchanged) {
      if (latexVisualNodeSignature(previous) !== latexVisualNodeSignature(canonical)) return null;
      continue;
    }
    if (node === canonical) continue;
    children ??= proposed.slice();
    children[index] = canonical;
  }
  return children ? { ...content, content: children } : content;
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

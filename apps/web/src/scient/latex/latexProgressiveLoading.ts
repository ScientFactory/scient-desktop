import type { Editor, JSONContent } from "@tiptap/core";
import { Fragment, type Node as DocumentNode, type Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/**
 * Meta on the transactions that add parsed blocks while a document opens.
 * They are not edits: no history, no source publication, no reclassification.
 * The value is "done" on the transaction that completes the document.
 */
export const LATEX_VISUAL_LOADING = "scientLatexVisualLoading";

export function isLatexVisualLoading(transaction: Transaction): boolean {
  return transaction.getMeta(LATEX_VISUAL_LOADING) !== undefined;
}

/** Roughly two screens of a dense manuscript, in parsed JSON characters. */
const OPENING_BUDGET = 8_000;
/** Work per loading slice; layout of the slice follows in the same frame. */
const SLICE_BUDGET_MS = 8;
/**
 * Every transaction also costs time in proportion to the blocks already
 * loaded (the view, node views, rendering). A slice adds at least this share
 * of them, so a long document loads in a few hundred slices at most, not one
 * block per frame.
 */
const SLICE_GROWTH = 1 / 64;

const wholeDocuments = new WeakMap<JSONContent, DocumentNode>();

/**
 * The whole parsed document as editor nodes, built once: opening counts its
 * references from it, and loading inserts its blocks.
 */
export function latexWholeDocument(schema: Schema, document: JSONContent): DocumentNode {
  let whole = wholeDocuments.get(document);
  if (!whole || whole.type.schema !== schema)
    wholeDocuments.set(document, (whole = schema.nodeFromJSON(document)));
  return whole;
}

export interface LatexOpeningPlan {
  /** The whole parsed document. */
  readonly document: JSONContent;
  /** The document the editor is created with: `blocks[start, end)`. */
  readonly content: JSONContent;
  readonly blocks: readonly JSONContent[];
  readonly start: number;
  readonly end: number;
}

/** The blocks shown at once, from `start` (a remembered reading block) forward. */
export function latexOpeningPlan(document: JSONContent, start = 0): LatexOpeningPlan {
  const blocks = document.content ?? [];
  const first = Math.min(Math.max(0, start), Math.max(0, blocks.length - 1));
  let end = first;
  let size = 0;
  while (end < blocks.length && (end === first || size < OPENING_BUDGET)) {
    size += JSON.stringify(blocks[end]).length;
    end++;
  }
  return {
    document,
    content: { ...document, content: blocks.slice(first, end) },
    blocks,
    start: first,
    end,
  };
}

/**
 * Adds the remaining blocks a slice per frame, alternating below and above the
 * opening blocks. The reading anchor keeps visible content still meanwhile.
 * Stops when anything else changes the document; `onDone(false)` then leaves
 * completion to that change (an outside source revision replaces the whole
 * projection). Returns a cancel function.
 */
export function loadLatexVisualDocument(
  editor: Editor,
  plan: LatexOpeningPlan,
  events: { readonly onDone: (complete: boolean) => void },
): () => void {
  const { blocks } = plan;
  let before = plan.start;
  let after = plan.end;
  let expected = editor.state.doc;
  // Milliseconds per parsed JSON character, learned from each slice. A slice
  // takes as many blocks as fit the budget, and at least one.
  let costPerCharacter = 0.0005;
  const sizes = new Map<JSONContent, number>();
  const sizeOf = (block: JSONContent) => {
    let size = sizes.get(block);
    if (size === undefined) sizes.set(block, (size = JSON.stringify(block).length));
    return size;
  };
  let forward = true;
  let cancelled = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (complete: boolean) => {
    cancelled = true;
    events.onDone(complete);
  };
  let loaded = 0;
  for (let index = plan.start; index < plan.end; index++) loaded += sizeOf(blocks[index]!);
  const fits = (characters: number) =>
    characters * costPerCharacter < SLICE_BUDGET_MS || characters < loaded * SLICE_GROWTH;
  const step = () => {
    if (cancelled || editor.isDestroyed) return;
    if (editor.state.doc !== expected) {
      finish(false);
      return;
    }
    if (after >= blocks.length) forward = false;
    else if (before <= 0) forward = true;
    const started = performance.now();
    let characters = 0;
    let first = forward ? after : before;
    let last = first;
    // A block joins the slice only if the slice still fits with it.
    if (forward)
      while (last < blocks.length && (last === first || fits(characters + sizeOf(blocks[last]!))))
        characters += sizeOf(blocks[last++]!);
    else
      while (first > 0 && (first === last || fits(characters + sizeOf(blocks[first - 1]!))))
        characters += sizeOf(blocks[--first]!);
    const whole = latexWholeDocument(editor.schema, plan.document);
    const nodes = Array.from({ length: last - first }, (_, index) => whole.child(first + index));
    if (forward) after = last;
    else before = first;
    const complete = before <= 0 && after >= blocks.length;
    const transaction = editor.state.tr
      .insert(forward ? editor.state.doc.content.size : 0, Fragment.from(nodes))
      .setMeta(LATEX_VISUAL_LOADING, complete ? "done" : "loading")
      .setMeta("addToHistory", false)
      .setMeta("preventUpdate", true);
    editor.view.dispatch(transaction);
    expected = editor.state.doc;
    forward = !forward;
    // Includes the layout ProseMirror forces while it syncs the selection.
    const elapsed = performance.now() - started;
    loaded += characters;
    if (characters > 0) costPerCharacter = (costPerCharacter + elapsed / characters) / 2;
    if (complete) finish(true);
    else schedule();
  };
  // One slice per frame, after it paints: input and painting are never held.
  const schedule = () => {
    frame = requestAnimationFrame(() => {
      timer = setTimeout(step, 0);
    });
  };
  if (plan.start <= 0 && plan.end >= blocks.length) {
    queueMicrotask(() => {
      if (!cancelled) finish(true);
    });
  } else schedule();
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

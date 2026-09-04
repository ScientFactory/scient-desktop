import { diffArrays } from "diff";

import { createMarkdownSourceLedger, type MarkdownSourcePatch } from "./sourceLedger.ts";

const MAX_SOURCE_LENGTH = 256_000;
const MAX_BLOCKS = 2_000;
const MAX_EDIT_LENGTH = 200;

interface BlockEdit {
  readonly start: number;
  readonly end: number;
  readonly inserted: readonly string[];
}

export interface MarkdownReconciliation {
  readonly source: string;
  /** Changes from the local draft to the combined draft, in UTF-16 offsets. */
  readonly patches: readonly MarkdownSourcePatch[];
}

function blocks(source: string) {
  const ledger = createMarkdownSourceLedger(source);
  return {
    ledger,
    tokens: ledger.blocks.map((block) => source.slice(block.start, block.end)),
  };
}

function edits(before: readonly string[], after: readonly string[]): BlockEdit[] | null {
  const changes = diffArrays([...before], [...after], {
    comparator: (a, b) => a.trimEnd() === b.trimEnd(),
    maxEditLength: MAX_EDIT_LENGTH,
    timeout: 20,
  });
  if (!changes) return null;
  const result: BlockEdit[] = [];
  let offset = 0;
  let nextOffset = 0;
  let pending: { start: number; end: number; inserted: string[] } | null = null;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (pending) result.push(pending);
      pending = null;
      for (let index = 0; index < change.value.length; index++) {
        if (before[offset + index] !== after[nextOffset + index])
          result.push({
            start: offset + index,
            end: offset + index + 1,
            inserted: [after[nextOffset + index]!],
          });
      }
      offset += change.value.length;
      nextOffset += change.value.length;
    } else {
      pending ??= { start: offset, end: offset, inserted: [] };
      if (change.removed) {
        offset += change.value.length;
        pending.end = offset;
      } else {
        pending.inserted.push(...after.slice(nextOffset, nextOffset + change.value.length));
        nextOffset += change.value.length;
      }
    }
  }
  if (pending) result.push(pending);
  return result;
}

function sameEdit(a: BlockEdit, b: BlockEdit): boolean {
  return a.start === b.start && a.end === b.end && a.inserted.join("") === b.inserted.join("");
}

function overlap(a: BlockEdit, b: BlockEdit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) {
    return (
      (a.start > b.start && a.start < b.end) ||
      (b.inserted.length === 0 && a.start >= b.start && a.start <= b.end)
    );
  }
  if (b.start === b.end) return overlap(b, a);
  return a.start < b.end && b.start < a.end;
}

/** Conservative block correspondence; repeated equal blocks are not stable identities. */
function unique(tokens: readonly string[]): boolean {
  return new Set(tokens.map((token) => token.trimEnd())).size === tokens.length;
}

/**
 * A bounded, exact-source three-way merge. Compound blocks are indivisible;
 * uncertain ownership or document-wide syntax changes remain explicit conflicts.
 * This function never writes, normalizes Markdown, or emits conflict markers.
 */
export function reconcileMarkdown(
  base: string,
  local: string,
  disk: string,
): MarkdownReconciliation | null {
  if (Math.max(base.length, local.length, disk.length) > MAX_SOURCE_LENGTH) return null;
  try {
    const original = blocks(base);
    const mine = blocks(local);
    const theirs = blocks(disk);
    if (Math.max(original.tokens.length, mine.tokens.length, theirs.tokens.length) > MAX_BLOCKS)
      return null;
    if (
      original.ledger.prefix !== mine.ledger.prefix ||
      original.ledger.prefix !== theirs.ledger.prefix
    )
      return null;
    if (![original, mine, theirs].every((item) => unique(item.tokens))) return null;
    const contextual = (item: ReturnType<typeof blocks>) =>
      JSON.stringify(item.ledger.contextSources);
    if (contextual(original) !== contextual(mine) || contextual(original) !== contextual(theirs))
      return null;
    const localEdits = edits(original.tokens, mine.tokens);
    const diskEdits = edits(original.tokens, theirs.tokens);
    if (!localEdits || !diskEdits) return null;
    const combined = [...localEdits];
    for (const external of diskEdits) {
      if (localEdits.some((own) => sameEdit(own, external))) continue;
      if (localEdits.some((own) => overlap(own, external))) return null;
      combined.push(external);
    }
    combined.sort((a, b) => a.start - b.start || a.end - b.end);
    const tokens: string[] = [];
    let cursor = 0;
    for (const edit of combined) {
      tokens.push(...original.tokens.slice(cursor, edit.start), ...edit.inserted);
      cursor = edit.end;
    }
    tokens.push(...original.tokens.slice(cursor));
    const source = original.ledger.prefix + tokens.join("");
    // Joining independent changes must not turn a paragraph into a fence/list,
    // absorb an adjacent block, or otherwise change the chosen ownership.
    const parsed = blocks(source);
    if (
      parsed.ledger.prefix !== original.ledger.prefix ||
      contextual(parsed) !== contextual(original) ||
      parsed.tokens.length !== tokens.length ||
      parsed.tokens.some((token, index) => token !== tokens[index])
    )
      return null;
    const incoming = edits(mine.tokens, tokens);
    if (!incoming) return null;
    const boundary = (index: number) => mine.ledger.blocks[index]?.start ?? local.length;
    return {
      source,
      patches: incoming.map((edit) => ({
        start: boundary(edit.start),
        end: boundary(edit.end),
        replacement: edit.inserted.join(""),
      })),
    };
  } catch {
    return null;
  }
}

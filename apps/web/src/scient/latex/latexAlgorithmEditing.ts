import type { JSONContent } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";
import { algorithmLineLayout } from "./latexAlgorithm";

export const algorithmBlockEnds: Readonly<Record<string, string>> = {
  For: "EndFor",
  ForAll: "EndFor",
  If: "EndIf",
  While: "EndWhile",
  Repeat: "Until",
  Loop: "EndLoop",
};
const closing = new Set(Object.values(algorithmBlockEnds));
const branch = (name: string) => name === "Else" || name === "ElsIf";

/** Whole structures are editing units; paired lines and branch boundaries never move separately. */
export function algorithmStepSelection(node: Node, at: number, selection: Selection) {
  if (node.attrs.layout?.kind !== "algorithm" || !node.childCount) return null;
  const whole = selection.from === at && selection.to === at + node.nodeSize;
  if (!whole && (selection.from < at + 1 || selection.to > at + node.nodeSize - 1)) return null;
  const names: string[] = [];
  const offsets: number[] = [];
  node.forEach((row, offset) => {
    names.push(String(row.attrs.command));
    offsets.push(at + 1 + offset);
  });
  if (!algorithmLineLayout(names, Number(node.attrs.layout.interval))) return null;
  let first = 0,
    last = names.length - 1;
  if (!whole) {
    first = offsets.findIndex(
      (offset, index) =>
        selection.from >= offset && selection.from < offset + node.child(index).nodeSize,
    );
    if (first < 0) return null;
    last = first;
    for (let index = first; index < offsets.length; index++) {
      if (offsets[index]! < selection.to) last = index;
    }
  }
  const pairs = new Map<number, number>();
  const parents: (number | null)[] = [];
  const stack: number[] = [];
  names.forEach((name, index) => {
    if (closing.has(name)) {
      const open = stack.pop()!;
      pairs.set(open, index);
      pairs.set(index, open);
      parents[index] = parents[open] ?? null;
    } else {
      parents[index] = stack.at(-1) ?? null;
      if (algorithmBlockEnds[name]) stack.push(index);
    }
  });
  let start = first,
    end = last;
  for (let index = start; index <= end; index++) {
    const partner = branch(names[index]!) ? parents[index] : pairs.get(index);
    if (partner == null) continue;
    if (partner < start) {
      start = partner;
      index = start - 1;
    }
    end = Math.max(end, partner, pairs.get(partner) ?? partner);
  }
  let owner = first;
  if (closing.has(names[owner]!)) owner = pairs.get(owner)!;
  let condition: number | null = owner;
  while (condition !== null && names[condition] !== "If") condition = parents[condition] ?? null;
  const conditionEnd = condition !== null ? pairs.get(condition)! : null;
  const elseAt =
    condition === null
      ? -1
      : names.findIndex((name, index) => name === "Else" && parents[index] === condition);
  let wrapper: number | null =
    algorithmBlockEnds[names[start]!] && pairs.get(start) === end
      ? start
      : (parents[start] ?? null);
  while (wrapper !== null && (pairs.get(wrapper) ?? -1) < end) wrapper = parents[wrapper] ?? null;
  const canUnwrap = wrapper !== null;
  const neighbor = (direction: -1 | 1) => {
    const adjacent = direction < 0 ? start - 1 : end + 1;
    const name = names[adjacent];
    if (!name || branch(name)) return null;
    const other = pairs.get(adjacent) ?? adjacent;
    const from = Math.min(adjacent, other),
      to = Math.max(adjacent, other);
    if ((from < start && to >= start) || (from <= end && to > end)) return null;
    return parents[from] === parents[start] && parents[to] === parents[end] ? { from, to } : null;
  };
  return {
    first,
    last,
    start,
    end,
    offsets,
    pairs,
    wrapper,
    canUnwrap,
    condition,
    conditionEnd,
    elseAt,
    up: neighbor(-1),
    down: neighbor(1),
    names,
    parents,
    whole,
    caret: selection.empty,
  };
}

export type AlgorithmStepOperation =
  | "add"
  | "wrap"
  | "remove"
  | "unwrap"
  | "up"
  | "down"
  | "comment"
  | "else"
  | "elseif";

/** Produce an atomic, balanced edit before the source preservation gate accepts it. */
export function editAlgorithmSteps(
  node: Node,
  selection: NonNullable<ReturnType<typeof algorithmStepSelection>>,
  operation: AlgorithmStepOperation,
  kind = "State",
) {
  const rows: JSONContent[] = node.toJSON().content ?? [];
  const line = (command: string): JSONContent => ({
    type: "latexAlgorithmLine",
    attrs: { command },
  });
  let index = selection.first;
  let focusComment = false;
  if (operation === "add") {
    index = selection.caret ? selection.first + 1 : selection.end + 1;
    const end = algorithmBlockEnds[kind];
    rows.splice(index, 0, ...(end ? [line(kind), line("State"), line(end)] : [line(kind)]));
    if (kind === "Repeat" || kind === "Loop") index++;
  } else if (operation === "wrap") {
    const end = algorithmBlockEnds[kind];
    if (!end) return null;
    rows.splice(selection.end + 1, 0, line(end));
    rows.splice(selection.start, 0, line(kind));
    index = selection.start + (kind === "Repeat" || kind === "Loop" ? 1 : 0);
  } else if (operation === "comment") {
    if (selection.first !== selection.last) return null;
    const selected = rows[index]!;
    if (!selected.content?.some((child) => child.type === "latexAlgorithmComment"))
      selected.content = [...(selected.content ?? []), { type: "latexAlgorithmComment" }];
    focusComment = true;
  } else if (operation === "else" || operation === "elseif") {
    if (
      selection.condition === null ||
      selection.conditionEnd === null ||
      (operation === "else" && selection.elseAt >= 0)
    )
      return null;
    index = selection.elseAt >= 0 ? selection.elseAt : selection.conditionEnd;
    rows.splice(index, 0, line(operation === "else" ? "Else" : "ElsIf"), line("State"));
    if (operation === "else") index++;
  } else if (operation === "unwrap") {
    if (!selection.canUnwrap || selection.wrapper === null) return null;
    index = selection.wrapper;
    const end = selection.pairs.get(index)!;
    const contents = rows.slice(index, end + 1).flatMap((row, offset) => {
      const at = index + offset;
      if (
        at !== index &&
        at !== end &&
        !(branch(selection.names[at]!) && selection.parents[at] === index)
      )
        return [row];
      // Retain conditions and comments when removing their generated keywords.
      return row.content?.length ? [{ ...row, attrs: { ...row.attrs, command: "State" } }] : [];
    });
    rows.splice(index, end - index + 1, ...contents);
  } else if (operation === "remove") {
    rows.splice(selection.start, selection.end - selection.start + 1);
    index = selection.start;
  } else {
    const neighbor = operation === "up" ? selection.up : selection.down;
    if (!neighbor) return null;
    const selected = rows.slice(selection.start, selection.end + 1);
    const adjacent = rows.slice(neighbor.from, neighbor.to + 1);
    const from = Math.min(selection.start, neighbor.from),
      to = Math.max(selection.end, neighbor.to);
    rows.splice(
      from,
      to - from + 1,
      ...(operation === "up" ? [...selected, ...adjacent] : [...adjacent, ...selected]),
    );
    index = operation === "up" ? from : from + adjacent.length;
  }
  if (!rows.length) rows.push(line("State"));
  if (
    !algorithmLineLayout(
      rows.map((row) => String(row.attrs?.command)),
      Number(node.attrs.layout.interval),
    )
  )
    return null;
  return { rows, index: Math.min(index, rows.length - 1), focusComment };
}

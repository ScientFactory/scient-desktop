import type { KeybindingWhenNode } from "@t3tools/contracts";
import {
  parseKeybindingWhenExpression,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";
import { normalizeKeys } from "./keys";

function identifiers(node: KeybindingWhenNode | undefined, names: Set<string>) {
  if (!node) return;
  if (node.type === "identifier") {
    if (!["true", "false"].includes(node.name)) names.add(node.name);
  } else if (node.type === "not") identifiers(node.node, names);
  else {
    identifiers(node.left, names);
    identifiers(node.right, names);
  }
}
function evaluate(node: KeybindingWhenNode | undefined, state: Record<string, boolean>): boolean {
  if (!node) return true;
  if (node.type === "identifier")
    return node.name === "true" || (node.name !== "false" && state[node.name] === true);
  if (node.type === "not") return !evaluate(node.node, state);
  return node.type === "and"
    ? evaluate(node.left, state) && evaluate(node.right, state)
    : evaluate(node.left, state) || evaluate(node.right, state);
}
/** Bounded overlap check. Complex expressions conservatively warn instead of silently passing. */
export function conditionsOverlap(a: string, b: string): boolean {
  const left = a.trim() ? parseKeybindingWhenExpression(a) : undefined;
  const right = b.trim() ? parseKeybindingWhenExpression(b) : undefined;
  if (left === null || right === null) return true;
  const names = new Set<string>();
  identifiers(left, names);
  identifiers(right, names);
  if (names.size > 12) return true;
  const keys = [...names];
  for (let mask = 0; mask < 2 ** keys.length; mask++) {
    const state = Object.fromEntries(keys.map((key, index) => [key, Boolean(mask & (1 << index))]));
    if (state.isWeb === true && state.isDesktop === true) continue;
    if (state.terminalFocus === true && state.previewFocus === true) continue;
    if (evaluate(left, state) && evaluate(right, state)) return true;
  }
  return false;
}
export function appKeysEqual(a: string, b: string, mac: boolean): boolean {
  const canonical = (text: string) => {
    const shortcut = parseKeybindingShortcut(text);
    if (!shortcut) return text;
    return normalizeKeys(
      [
        ...(shortcut.modKey ? ["mod"] : []),
        ...(shortcut.metaKey ? ["meta"] : []),
        ...(shortcut.ctrlKey ? ["ctrl"] : []),
        ...(shortcut.altKey ? ["alt"] : []),
        ...(shortcut.shiftKey ? ["shift"] : []),
        shortcut.key === " " ? "space" : shortcut.key === "+" ? "plus" : shortcut.key,
      ].join("+"),
      mac,
    );
  };
  return canonical(a) === canonical(b);
}

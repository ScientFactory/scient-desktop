/** Platform-independent persisted notation; resolve Mod only when matching. */
export function isMacKeyboard(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
) {
  return /Mac|iPhone|iPad/u.test(platform);
}
const namedKeys = new Set([
  "space",
  "escape",
  "esc",
  "enter",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "plus",
]);
export function normalizeKeys(keys: string, mac: boolean): string {
  return keys
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .map((stroke) => {
      if (stroke === "+") return "plus";
      const parts = stroke.split("+");
      const key = parts.pop()!;
      const modifiers = new Set(
        parts.map((part) => (part === "mod" ? (mac ? "meta" : "ctrl") : part)),
      );
      return ["ctrl", "meta", "alt", "shift"]
        .filter((part) => modifiers.has(part))
        .concat(key === "esc" ? "escape" : key)
        .join("+");
    })
    .join(" ");
}
export function validateKeys(keys: string): void {
  if (!keys || keys.length > 100 || keys.trim().split(/\s+/u).length > 4)
    throw new Error("Use one to four shortcut strokes.");
  const strokes = keys.trim().toLowerCase().split(/\s+/u);
  if (!/^(?:mod|ctrl|meta|alt)\+/u.test(strokes[0]!))
    throw new Error("Start a shortcut with a modifier; ordinary typing is reserved.");
  for (const stroke of strokes) {
    if (stroke === "+") continue;
    const parts = stroke.split("+");
    const key = parts.pop()!;
    if (
      !key ||
      (key.length !== 1 && !namedKeys.has(key) && !/^f(?:[1-9]|1[0-9]|2[0-4])$/u.test(key)) ||
      parts.some((part) => !["mod", "ctrl", "meta", "alt", "shift"].includes(part)) ||
      new Set(parts).size !== parts.length
    )
      throw new Error(`Invalid shortcut stroke: ${stroke}`);
  }
}
export function eventStroke(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> &
    Partial<Pick<KeyboardEvent, "isComposing" | "getModifierState">>,
  inSequence = false,
): string | null {
  if (
    event.isComposing ||
    ["Dead", "Process"].includes(event.key) ||
    event.getModifierState?.("AltGraph")
  )
    return null;
  let key = event.key === " " ? "space" : event.key === "+" ? "plus" : event.key.toLowerCase();
  if (["control", "alt", "meta", "shift"].includes(key)) return null;
  const physical = /^Key([A-Z])$/u.exec(event.code)?.[1];
  if (
    physical &&
    !/^[a-z]$/u.test(key) &&
    (inSequence || event.altKey || event.ctrlKey || event.metaKey)
  )
    key = physical.toLowerCase();
  // Digit shortcuts retain their physical digit when Shift produces punctuation.
  const digit = /^Digit([0-9])$/u.exec(event.code)?.[1];
  if (digit && (event.ctrlKey || event.metaKey || event.altKey)) key = digit;
  return [
    ...(event.ctrlKey ? ["ctrl"] : []),
    ...(event.metaKey ? ["meta"] : []),
    ...(event.altKey ? ["alt"] : []),
    ...(event.shiftKey && (/^[a-z0-9]$/u.test(key) || event.key.length > 1) ? ["shift"] : []),
    key,
  ].join("+");
}
export function keysOverlap(a: string, b: string, mac: boolean): boolean {
  const left = normalizeKeys(a, mac),
    right = normalizeKeys(b, mac);
  return left === right || left.startsWith(right + " ") || right.startsWith(left + " ");
}
/** Editing primitives belong to the host editor, not configurable authoring actions. */
export function reservedEditingKeys(keys: string, mac: boolean): boolean {
  const first = normalizeKeys(keys, mac).split(" ")[0];
  const mod = mac ? "meta" : "ctrl";
  return (
    ["ctrl+enter", "meta+enter"].includes(first ?? "") ||
    ["a", "c", "x", "v", "z", "y", "s", "shift+z", "shift+v"].some(
      (key) => first === mod + "+" + key,
    )
  );
}
export function labelKeys(keys: string, mac = isMacKeyboard()): string {
  const names: Readonly<Record<string, string>> = {
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    pageup: "Page Up",
    pagedown: "Page Down",
  };
  return keys
    .split(" ")
    .map((stroke) =>
      (stroke === "+" ? "plus" : stroke)
        .split("+")
        .map((part) =>
          part === "mod"
            ? mac
              ? "Cmd"
              : "Ctrl"
            : part === "meta"
              ? "Cmd"
              : part === "ctrl"
                ? "Ctrl"
                : part === "alt"
                  ? mac
                    ? "Option"
                    : "Alt"
                  : part === "plus"
                    ? "+"
                    : part.length === 1
                      ? part.toUpperCase()
                      : (names[part] ?? (part[0]?.toUpperCase() ?? "") + part.slice(1)),
        )
        .join("+"),
    )
    .join(" → ");
}

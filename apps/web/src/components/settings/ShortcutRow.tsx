import { Kbd, KbdGroup } from "../ui/kbd";

/** General and document shortcuts share one row and one shortcut-pill treatment. */
export const SHORTCUT_ROW_CLASS =
  "group/row relative rounded-none after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-gradient-to-r after:from-border/35 after:via-border/20 after:to-transparent after:content-[''] last:after:hidden";

export const SHORTCUT_PILL_BUTTON_CLASS =
  "inline-flex h-8 cursor-pointer items-center rounded-md border border-transparent px-1.5 outline-none transition-colors hover:border-border/70 hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 sm:h-7";

function keyedParts(values: readonly string[]) {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const occurrence = seen.get(value) ?? 0;
    seen.set(value, occurrence + 1);
    return { value, key: occurrence === 0 ? value : `${value}-${occurrence}` };
  });
}

function keyLabel(part: string, mac: boolean): string {
  if (part === "mod") return mac ? "⌘" : "Ctrl";
  if (part === "meta") return mac ? "⌘" : "Meta";
  if (part === "ctrl") return mac ? "⌃" : "Ctrl";
  if (part === "alt") return mac ? "⌥" : "Alt";
  if (part === "shift") return "⇧";
  if (part === "plus" || part === "") return "+";
  const named: Readonly<Record<string, string>> = {
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    pageup: "Page Up",
    pagedown: "Page Down",
    space: "Space",
    esc: "Esc",
  };
  return named[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part);
}

export function ShortcutKeys({ value }: { readonly value: string }) {
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  const strokes = keyedParts(value.trim().split(/\s+/u));
  return (
    <KbdGroup className="bg-transparent p-0 shadow-none">
      {strokes.map((stroke, strokeIndex) => (
        <span key={stroke.key} className="inline-flex items-center gap-1">
          {strokeIndex > 0 ? (
            <span aria-hidden className="px-0.5 text-muted-foreground">
              →
            </span>
          ) : null}
          {keyedParts(stroke.value.replace(/\+$/u, "plus").split("+")).map((part) => (
            <Kbd key={part.key} className="min-w-6 justify-center px-1.5">
              {keyLabel(part.value, mac)}
            </Kbd>
          ))}
        </span>
      ))}
    </KbdGroup>
  );
}

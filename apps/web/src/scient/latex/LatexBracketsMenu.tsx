import { useId, useState } from "react";
import { MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { DockCommandItem } from "../writing/dockChrome";
import { LatexSelect } from "./LatexSelect";
import {
  MATH_BRACKETS,
  MATH_BRACKET_SIZES,
  mathBracketsTemplate,
  type MathBracket,
  type MathBracketSize,
} from "./mathBrackets";

const leftOptions = MATH_BRACKETS.map((bracket) => ({ value: bracket.value, label: bracket.left }));
const rightOptions = MATH_BRACKETS.map((bracket) => ({
  value: bracket.value,
  label: bracket.right,
}));
const sizeOptions = MATH_BRACKET_SIZES.map((size) => ({
  value: size,
  label: size === "auto" ? "Auto" : size === "normal" ? "Normal" : `\\${size}`,
}));
const defaults = { left: "round", right: "round", size: "auto", match: true } as const;

/** Bracket choices are a draft; only Insert runs an editing command. */
export function LatexBracketsMenu({
  disabled,
  onInsert,
}: {
  disabled: boolean;
  onInsert: (tex: string) => void;
}) {
  const ownerId = useId();
  const [draft, setDraft] = useState<{
    left: MathBracket;
    right: MathBracket;
    size: MathBracketSize;
    match: boolean;
  }>(defaults);
  const template = mathBracketsTemplate(draft.left, draft.right, draft.size);
  return (
    <MenuSub
      onOpenChange={(open) => {
        if (open) setDraft(defaults);
      }}
    >
      <MenuSubTrigger id={ownerId} disabled={disabled}>
        Brackets
      </MenuSubTrigger>
      <MenuSubPopup
        className="w-max min-w-0 max-w-(--available-width)"
        data-dock-command-scope="latex"
        data-writing-menu-owner={ownerId}
        data-keybinding-capture=""
        onKeyDown={(event) => {
          // Select choices are portaled; their own popup owns its keyboard input.
          if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target))
            return;
          if (event.key === "Tab") {
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), [role="menuitem"]:not([data-disabled])',
              ),
            );
            if (!controls.length) return;
            const at = controls.findIndex(
              (control) => control === control.ownerDocument.activeElement,
            );
            const next =
              at < 0
                ? event.shiftKey
                  ? controls.length - 1
                  : 0
                : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
            event.preventDefault();
            event.stopPropagation();
            controls[next]?.focus();
          } else if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        <div
          className="grid min-w-0 gap-2 p-2 text-xs"
          role="group"
          aria-label="Bracket options"
          dir="ltr"
        >
          <div className="flex min-w-0 flex-wrap gap-2">
            <label className="grid min-w-max flex-1 basis-0 gap-1">
              Left
              <LatexSelect
                aria-label="Left bracket"
                size="sm"
                width="options"
                value={draft.left}
                disabled={disabled}
                options={leftOptions}
                onValueChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    left: value as MathBracket,
                    right: current.match ? (value as MathBracket) : current.right,
                  }))
                }
              />
            </label>
            <label className="grid min-w-max flex-1 basis-0 gap-1">
              Right
              <LatexSelect
                aria-label="Right bracket"
                size="sm"
                width="options"
                value={draft.right}
                disabled={disabled || draft.match}
                options={rightOptions}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, right: value as MathBracket }))
                }
              />
            </label>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <label className="grid min-w-max flex-1 gap-1">
              Size
              <LatexSelect
                aria-label="Bracket size"
                size="sm"
                width="options"
                value={draft.size}
                disabled={disabled}
                options={sizeOptions}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, size: value as MathBracketSize }))
                }
              />
            </label>
            <label className="grid shrink-0 content-start gap-1">
              Match
              <span className="flex h-8 items-center sm:h-7">
                <Switch
                  size="sm"
                  motion="none"
                  aria-label="Match brackets"
                  checked={draft.match}
                  disabled={disabled}
                  onCheckedChange={(match) =>
                    setDraft((current) => ({
                      ...current,
                      match,
                      right: match ? current.left : current.right,
                    }))
                  }
                />
              </span>
            </label>
          </div>
        </div>
        <div className="flex justify-end px-2 pb-1">
          <DockCommandItem
            size="compact"
            disabled={disabled || !template}
            onClick={() => {
              if (template) onInsert(template);
            }}
          >
            Insert
          </DockCommandItem>
        </div>
      </MenuSubPopup>
    </MenuSub>
  );
}

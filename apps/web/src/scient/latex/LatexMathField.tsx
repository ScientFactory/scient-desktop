import { MathfieldElement } from "mathlive";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import "mathlive/fonts.css";
import { mathSymbolMacros } from "./mathSymbolPresentation";

// Vite packages fonts alongside the renderer; no CDN or network math service.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;

export interface LatexMathFieldHandle {
  readonly focus: () => void;
  readonly insert: (latex: string) => void;
  readonly command: (
    command:
      | "moveToSuperscript"
      | "moveToSubscript"
      | "addRowAfter"
      | "addColumnAfter"
      | "removeRow"
      | "removeColumn",
  ) => boolean;
}

const INLINE_SHORTCUTS = {
  alpha: "\\alpha",
  beta: "\\beta",
  gamma: "\\gamma",
  delta: "\\delta",
  theta: "\\theta",
  lambda: "\\lambda",
  mu: "\\mu",
  pi: "\\pi",
  sigma: "\\sigma",
  phi: "\\phi",
  omega: "\\omega",
  inf: "\\infty",
  sqrt: "\\sqrt{#0}",
  sum: "\\sum_{#0}^{#1}",
  prod: "\\prod_{#0}^{#1}",
  int: "\\int_{#0}^{#1}",
  lim: "\\lim_{#0 \\to #1}",
  "->": "\\to",
  "<=": "\\le",
  ">=": "\\ge",
  "!=": "\\ne",
} as const;

export const LatexMathField = forwardRef<
  LatexMathFieldHandle,
  {
    readonly value: string;
    readonly disabled: boolean;
    readonly display: boolean;
    readonly onChange: (value: string) => string;
    readonly onFocus: () => void;
    readonly onExit: (direction: -1 | 1) => void;
    readonly onRemoveEmpty: () => void;
  }
>(function LatexMathField(
  { value, disabled, display, onChange, onFocus, onExit, onRemoveEmpty },
  forwardedRef,
) {
  const host = useRef<HTMLSpanElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const change = useRef(onChange);
  const focus = useRef(onFocus);
  const exit = useRef(onExit);
  const removeEmpty = useRef(onRemoveEmpty);
  useEffect(() => {
    change.current = onChange;
    focus.current = onFocus;
    exit.current = onExit;
    removeEmpty.current = onRemoveEmpty;
  }, [onChange, onFocus, onExit, onRemoveEmpty]);
  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => field.current?.focus(),
      command: (command) => {
        const math = field.current;
        if (!math || math.readOnly) return false;
        math.focus();
        return math.executeCommand(command);
      },
      insert: (latex) => {
        const math = field.current;
        if (!math || math.readOnly) return;
        math.insert(latex, {
          focus: true,
          format: "latex",
          insertionMode: "replaceSelection",
          selectionMode: "placeholder",
        });
      },
    }),
    [],
  );
  useEffect(() => {
    const math = new MathfieldElement();
    math.setAttribute("aria-label", display ? "Display equation" : "Inline equation");
    math.setAttribute("default-mode", display ? "math" : "inline-math");
    host.current?.append(math);
    // Use native caret placement and command completion inside the formula.
    // Scient supplies the surrounding toolbar instead of a second menu/keyboard.
    // MathLive's option setters require the custom element to be connected.
    math.mathVirtualKeyboardPolicy = "manual";
    math.popoverPolicy = "auto";
    math.environmentPopoverPolicy = "off";
    math.macros = { ...math.macros, ...mathSymbolMacros() };
    math.smartFence = true;
    math.smartSuperscript = true;
    math.inlineShortcuts = INLINE_SHORTCUTS;
    const input = () => {
      // A command under construction (including its ghost suggestion) is a
      // local draft. Publish only after MathLive turns it into math atoms.
      if (math.mode === "latex" || field.current !== math) return;
      const accepted = change.current(math.value);
      if (accepted !== math.value) math.setValue(accepted, { silenceNotifications: true });
    };
    const modeChange = () => {
      // MathLive changes mode before inserting the completed command.
      queueMicrotask(input);
    };
    const focused = () => {
      if (!math.readOnly) focus.current();
    };
    const blurred = () => {
      if (math.readOnly) return;
      // Preserve what was actually typed when leaving an unfinished command;
      // never accept a ghost suggestion just because focus moved elsewhere.
      if (math.mode === "latex") {
        math.executeCommand("complete");
        input();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (math.readOnly || event.isComposing) return;
      if (math.mode === "latex") {
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          math.executeCommand(["complete", "accept-all"]);
        }
        // Enter accepts a command and arrows select suggestions. They must
        // reach MathLive before any document-level navigation can take over.
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && math.value === "") {
        event.preventDefault();
        event.stopPropagation();
        removeEmpty.current();
        return;
      }
      if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        exit.current(1);
      }
    };
    const moveOut = (event: HTMLElementEventMap["move-out"]) => {
      if (math.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      exit.current(
        event.detail.direction === "backward" || event.detail.direction === "upward" ? -1 : 1,
      );
    };
    math.addEventListener("input", input);
    math.addEventListener("mode-change", modeChange);
    math.addEventListener("focus", focused);
    math.addEventListener("blur", blurred);
    math.addEventListener("keydown", keydown, true);
    math.addEventListener("move-out", moveOut);
    field.current = math;
    return () => {
      math.removeEventListener("input", input);
      math.removeEventListener("mode-change", modeChange);
      math.removeEventListener("focus", focused);
      math.removeEventListener("blur", blurred);
      math.removeEventListener("keydown", keydown, true);
      math.removeEventListener("move-out", moveOut);
      math.remove();
      field.current = null;
    };
  }, [display]);
  useEffect(() => {
    if (!field.current) return;
    if (field.current.readOnly !== disabled) field.current.readOnly = disabled;
    if (field.current.value !== value)
      field.current.setValue(value, { silenceNotifications: true });
  }, [disabled, value, display]);
  return <span ref={host} className="scient-latex-mathfield" contentEditable={false} />;
});

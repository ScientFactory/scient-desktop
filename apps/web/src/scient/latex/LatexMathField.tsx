import { MathfieldElement } from "mathlive";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import "mathlive/fonts.css";

// Vite packages fonts alongside the renderer; no CDN or network math service.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;

export interface LatexMathFieldHandle {
  readonly focus: () => void;
  readonly insert: (latex: string) => void;
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
  }
>(function LatexMathField({ value, disabled, display, onChange }, forwardedRef) {
  const host = useRef<HTMLSpanElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  }, [onChange]);
  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => field.current?.focus(),
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
    math.setAttribute("default-mode", "math");
    host.current?.append(math);
    // Scient provides its own compact contextual toolbar. Keep MathLive focused
    // on direct formula editing instead of exposing a second menu or keyboard.
    // MathLive's option setters require the custom element to be connected.
    math.mathVirtualKeyboardPolicy = "manual";
    math.popoverPolicy = "off";
    math.environmentPopoverPolicy = "off";
    math.smartFence = true;
    math.smartSuperscript = true;
    math.inlineShortcuts = INLINE_SHORTCUTS;
    const input = () => {
      const accepted = change.current(math.value);
      if (accepted !== math.value) math.setValue(accepted, { silenceNotifications: true });
    };
    math.addEventListener("input", input);
    field.current = math;
    return () => {
      math.removeEventListener("input", input);
      math.remove();
      field.current = null;
    };
  }, [display]);
  useEffect(() => {
    if (!field.current) return;
    field.current.readOnly = disabled;
    if (field.current.value !== value)
      field.current.setValue(value, { silenceNotifications: true });
  }, [disabled, value]);
  return <span ref={host} className="scient-latex-mathfield" contentEditable={false} />;
});

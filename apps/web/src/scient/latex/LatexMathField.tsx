import { MathfieldElement } from "mathlive";
import { useEffect, useRef } from "react";
import "mathlive/fonts.css";

// Vite packages fonts alongside the renderer; no CDN or network math service.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;

export function LatexMathField({
  value,
  disabled,
  display,
  onChange,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly display: boolean;
  readonly onChange: (value: string) => string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  }, [onChange]);
  useEffect(() => {
    const math = new MathfieldElement();
    math.mathVirtualKeyboardPolicy = "manual";
    math.setAttribute("aria-label", display ? "Display equation" : "Inline equation");
    math.setAttribute("default-mode", "math");
    const input = () => {
      const accepted = change.current(math.value);
      if (accepted !== math.value) math.setValue(accepted, { silenceNotifications: true });
    };
    math.addEventListener("input", input);
    host.current?.append(math);
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
}

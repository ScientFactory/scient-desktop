import { useId } from "react";
import type { MathSymbolOutline as Outline } from "./mathSymbolPresentation";

/** Trusted, bundled TeX paths; each tile owns its SVG definition IDs. */
export function MathSymbolOutline({ outline }: { outline: Outline }) {
  const id = useId().replace(/:/gu, "_");
  const body = outline.body.replace(
    /\b(id|(?:xlink:)?href)=(['"])(#?)([^'"]+)\2/gu,
    (_, attribute: string, quote: string, hash: string, reference: string) =>
      `${attribute === "id" ? "id" : "href"}=${quote}${hash}${id}-${reference}${quote}`,
  );
  return (
    <svg
      className="scient-latex-symbol-illustration"
      viewBox={outline.viewBox}
      fill="currentColor"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

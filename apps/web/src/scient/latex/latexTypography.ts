/** The font shorthand can be empty when reset-only longhands are nondefault.
 * Resolved longhands identify glyph metrics without losing ligature, numeric
 * variant or variable-font settings when measuring outside the live editor.
 */
export const latexTypographyProperties = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant-ligatures",
  "font-variant-caps",
  "font-variant-numeric",
  "font-variant-east-asian",
  "font-variant-alternates",
  "font-variant-position",
  "font-variant-emoji",
  "font-feature-settings",
  "font-variation-settings",
  "font-kerning",
  "font-optical-sizing",
  "font-language-override",
  "font-synthesis",
  "line-height",
  "text-rendering",
] as const;

export function latexTypographyKey(style: CSSStyleDeclaration): string {
  return JSON.stringify(
    latexTypographyProperties.map((property) => style.getPropertyValue(property)),
  );
}

export function copyLatexTypography(
  source: CSSStyleDeclaration,
  target: CSSStyleDeclaration,
): void {
  for (const property of latexTypographyProperties)
    target.setProperty(property, source.getPropertyValue(property));
}

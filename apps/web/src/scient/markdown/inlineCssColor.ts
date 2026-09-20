import "culori/css";
import { parse } from "culori/fn";

const INLINE_HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const INLINE_COLOR_FUNCTION_PATTERN = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;

/**
 * Returns an inline-code value when the complete token is an explicit CSS color.
 *
 * The prefix allowlist keeps named colors, variables, and composed expressions as
 * ordinary code. Culori then validates the full CSS syntax and supported color
 * space instead of duplicating the CSS Color grammar in this renderer.
 */
export function resolveInlineCssColor(value: string): string | null {
  const isSupportedNotation =
    INLINE_HEX_COLOR_PATTERN.test(value) || INLINE_COLOR_FUNCTION_PATTERN.test(value);

  return isSupportedNotation && parse(value) !== undefined ? value : null;
}

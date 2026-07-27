// FILE: fontFamily.test.ts
// Purpose: Verifies CSS-safe font-family normalization for user and theme settings.
// Layer: Web appearance utility tests
// Exports: Vitest coverage for fontFamily helpers.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONOSPACE_FONT_FAMILY_STACK,
  expandBundledVariableFontAliases,
  normalizeFontFamilyCssValue,
  normalizeMonospaceFontFamilyCssValue,
} from "./fontFamily";

describe("normalizeFontFamilyCssValue", () => {
  it("quotes multi-word family names inside a stack", () => {
    expect(normalizeFontFamilyCssValue("Fira Code, Menlo")).toBe('"Fira Code", Menlo');
  });
});

describe("normalizeMonospaceFontFamilyCssValue", () => {
  it("appends the default mono stack when a code font has no fallback", () => {
    expect(normalizeMonospaceFontFamilyCssValue("Jetbrains Mono")).toBe(
      `"Jetbrains Mono", ${DEFAULT_MONOSPACE_FONT_FAMILY_STACK}`,
    );
  });

  it("keeps existing generic mono fallbacks intact", () => {
    expect(normalizeMonospaceFontFamilyCssValue('"Geist Mono", ui-monospace')).toBe(
      '"Geist Mono", ui-monospace',
    );
  });

  it("preserves CSS-wide keywords as single values", () => {
    expect(normalizeMonospaceFontFamilyCssValue("inherit")).toBe("inherit");
  });
});

describe("expandBundledVariableFontAliases", () => {
  it("prepends the bundled variable family for a plain bundled name", () => {
    expect(expandBundledVariableFontAliases("Inter")).toBe('"Inter Variable", Inter');
  });

  it("expands each bundled family inside a multi-family stack", () => {
    expect(expandBundledVariableFontAliases("Geist, Inter")).toBe(
      '"Geist Variable", Geist, "Inter Variable", Inter',
    );
  });

  it("matches bundled names case-insensitively and through quotes", () => {
    expect(expandBundledVariableFontAliases('"geist mono", ui-monospace')).toBe(
      '"Geist Mono Variable", "geist mono", ui-monospace',
    );
  });

  it("leaves non-bundled families, generics, and keywords untouched", () => {
    expect(expandBundledVariableFontAliases("Satoshi, sans-serif")).toBe("Satoshi, sans-serif");
    expect(expandBundledVariableFontAliases("inherit")).toBe("inherit");
  });

  it("returns null for empty input", () => {
    expect(expandBundledVariableFontAliases(null)).toBeNull();
    expect(expandBundledVariableFontAliases("   ")).toBeNull();
  });
});

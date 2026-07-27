import { describe, expect, it } from "vitest";

import { isImeCompositionKeyEvent } from "./imeComposition";

describe("isImeCompositionKeyEvent", () => {
  it("is true while the browser reports an active composition", () => {
    expect(isImeCompositionKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("is true for the legacy keyCode 229 IME signal even when isComposing is false", () => {
    expect(isImeCompositionKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("is false for an ordinary Enter keypress outside composition", () => {
    expect(isImeCompositionKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

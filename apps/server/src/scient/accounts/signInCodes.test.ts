import { describe, expect, it } from "vite-plus/test";

import { codeBoxes, factorSeen } from "./signInCodes.ts";

describe("codeBoxes", () => {
  const first = "https://example.com|1|aa|#otp";
  // The same origin and selector, a later page load and challenge.
  const later = "https://example.com|2|bb|#otp";
  it("keeps every box of the run apart, and all that was seen of each", () => {
    const keyOnly = codeBoxes();
    keyOnly.note(first, "fits");
    keyOnly.note(first, "key");
    keyOnly.note(first, "fits");
    expect(keyOnly.outside(true)).toBe(false);
    // regression: the key in the first box hid a later box at the same selector, typed into
    // directly in the browser, and the row stayed `totp`.
    const reused = codeBoxes();
    reused.note(first, "fits");
    reused.note(first, "key");
    reused.note(later, "seen");
    expect(reused.outside(true)).toBe(true);
    // A box the key may answer, got past without it in a run that signed in, was typed elsewhere.
    const direct = codeBoxes();
    direct.note(first, "fits");
    expect(direct.outside(true)).toBe(true);
    expect(direct.outside(false)).toBe(false);
    // A code from outside, wherever it went, and a box only seen.
    const other = codeBoxes();
    other.note(first, "key");
    other.note(later, "other");
    expect(other.outside(true)).toBe(true);
    const seenOnly = codeBoxes();
    seenOnly.note(first, "seen");
    expect(seenOnly.outside(false)).toBe(true);
    // regression: a later key in a box it wasn't trusted with cleared what was seen there.
    const seenThenKey = codeBoxes();
    seenThenKey.note(first, "seen");
    seenThenKey.note(first, "fits");
    seenThenKey.note(first, "key");
    expect(seenThenKey.outside(true)).toBe(true);
    // Only the person's own "Use saved" there makes it the key's box.
    const chosen = codeBoxes();
    chosen.note(first, "seen");
    chosen.note(first, "fits");
    chosen.note(first, "chosen");
    expect(chosen.outside(true)).toBe(false);
  });
});

describe("factorSeen", () => {
  it("keeps the code mark for a run that also needed an outside code", () => {
    const signedIn = { unknownBox: false, outcome: "signed-in" } as const;
    // regression: the key plus a texted code signing in recorded `totp`, so renewal went quiet.
    expect(factorSeen({ ...signedIn, sentCode: true, typedKey: true })).toBe("code");
    expect(factorSeen({ ...signedIn, sentCode: false, typedKey: true })).toBe("totp");
    expect(factorSeen({ ...signedIn, sentCode: false, typedKey: false })).toBe("none");
    // regression: the key on one origin and an outside code box on another signed in as `totp`.
    expect(factorSeen({ ...signedIn, sentCode: false, unknownBox: true, typedKey: true })).toBe(
      "code",
    );
    // A refused key, or a box the key wasn't known to answer left unanswered by it, is a code.
    expect(
      factorSeen({ sentCode: false, unknownBox: false, typedKey: true, outcome: "code-rejected" }),
    ).toBe("code");
    expect(
      factorSeen({ sentCode: false, unknownBox: true, typedKey: false, outcome: "needs-user" }),
    ).toBe("code");
  });
});

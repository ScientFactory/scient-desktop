import { describe, expect, it } from "vite-plus/test";
import { accountHandoffInstruction } from "./scientSignInPage.ts";

describe("accountHandoffInstruction", () => {
  it("says a page that never loaded didn't load, not that a check waits", () => {
    expect(accountHandoffInstruction({ kind: "other", notLoaded: true })).toBe("Page didn't load.");
    expect(accountHandoffInstruction({ kind: "captcha" })).toBe("Solve the check.");
    expect(accountHandoffInstruction({ kind: "other", refused: "password", notLoaded: true })).toBe(
      "Password refused. Type it again.",
    );
  });

  it("names the factor: the number to tap, a security key, a texted code", () => {
    expect(accountHandoffInstruction({ kind: "push", number: "42" })).toBe(
      "Approve on your phone · 42",
    );
    expect(accountHandoffInstruction({ kind: "passkey", via: "security-key" })).toBe(
      "Touch your security key",
    );
    expect(accountHandoffInstruction({ kind: "code", via: "text" })).toBe(
      "Enter the code sent to your phone",
    );
    expect(accountHandoffInstruction({ kind: "code" })).toBe("Enter the code");
  });
});

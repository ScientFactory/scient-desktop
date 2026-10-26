import { describe, expect, it } from "vite-plus/test";
import { decideSignIn } from "./decision.ts";
import type { SignInDetection } from "./detection.ts";
import { matchesAccountOrigin } from "./origin.ts";
import { accountOtp, parseTotp } from "./totp.ts";

const page: SignInDetection = {
  origin: "https://login.example.com",
  username: "#user",
  password: "#pass",
  otp: null,
  submit: "button",
  challenge: null,
  signedIn: false,
};
const available = { username: true, password: true, otp: true };
describe("account sign-in decisions", () => {
  it("fills visible steps only on a matching origin and stops for challenges, missing fields and uncertain completion", () => {
    expect(decideSignIn(page, ["example.com"], available)).toEqual({
      type: "fill",
      fields: [
        { field: "username", selector: "#user" },
        { field: "password", selector: "#pass" },
      ],
      submit: "button",
    });
    expect(
      decideSignIn(
        { ...page, username: null, password: null, otp: "#code" },
        ["example.com"],
        available,
      ),
    ).toMatchObject({ type: "fill", fields: [{ field: "otp", selector: "#code" }] });
    expect(
      decideSignIn(
        { ...page, origin: "https://example.com.attacker.test" },
        ["example.com"],
        available,
      ).type,
    ).toBe("needs-user");
    expect(decideSignIn({ ...page, challenge: "captcha" }, ["example.com"], available).type).toBe(
      "needs-user",
    );
    expect(
      decideSignIn({ ...page, challenge: "passkey" }, ["example.com"], available),
    ).toMatchObject({ type: "needs-user", message: "Use your passkey in the browser." });
    expect(decideSignIn({ ...page, challenge: "push" }, ["example.com"], available)).toMatchObject({
      type: "needs-user",
      message: "Approve sign-in on your device.",
    });
    expect(decideSignIn(page, ["example.com"], { ...available, password: false }).type).toBe(
      "needs-user",
    );
    expect(
      decideSignIn({ ...page, username: null, password: null }, ["example.com"], available).type,
    ).toBe("needs-user");
    expect(
      decideSignIn(
        { ...page, username: null, password: null, signedIn: true },
        ["example.com"],
        available,
      ).type,
    ).toBe("signed-in");
  });
  it("matches exact HTTPS origins and domain boundaries without granting extra ports or insecure pages", () => {
    expect(matchesAccountOrigin("https://sso.example.com/path", ["example.com"])).toBe(true);
    expect(
      matchesAccountOrigin("https://example.com:8443/path", ["https://example.com:8443"]),
    ).toBe(true);
    for (const origin of [
      "https://example.com:8443",
      "http://example.com",
      "https://badexample.com",
      "https://example.com.evil.test",
      "https://u:p@example.com",
      "not a url",
    ])
      expect(matchesAccountOrigin(origin, ["example.com"])).toBe(false);
    expect(matchesAccountOrigin("https://sso.example.com", ["https://example.com"])).toBe(false);
  });
  it("parses outside TOTP formats using the RFC 6238 vector and sanitizes invalid setup errors", () => {
    const setup = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(parseTotp(setup).generate({ timestamp: 59_000 })).toBe("287082");
    expect(
      parseTotp(`otpauth://totp/example?secret=${setup}&digits=8&period=30`).generate({
        timestamp: 59_000,
      }),
    ).toBe("94287082");
    expect(accountOtp("123456", 0)).toBe("123456");
    for (const value of ["not:a:key", "otpauth://hotp/example?secret=GEZDGNBV&counter=1", ""])
      expect(() => parseTotp(value)).toThrow("The account's two-factor setup is invalid.");
  });
});

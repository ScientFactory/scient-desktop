import { describe, expect, it } from "vite-plus/test";
import { detectLoginFields, type LoginField } from "./loginFields.ts";

const field = (type: string, autocomplete = "", usable = true): LoginField => ({
  type,
  autocomplete,
  usable,
});

describe("login field selection", () => {
  it("prefers autocomplete and separates OTP, disabled and registration fields", () => {
    expect(
      detectLoginFields([
        field("text"),
        field("text", "section-login username"),
        field("password", "new-password"),
        field("password", "", false),
        field("password", "current-password"),
        field("text", "one-time-code"),
      ]),
    ).toEqual({ username: 1, password: 4, otp: 5 });
  });
  it("selects email and the last text input before the password as fallbacks", () => {
    expect(detectLoginFields([field("text"), field("email"), field("password")]).username).toBe(1);
    expect(
      detectLoginFields([field("text"), field("text"), field("password"), field("text")]),
    ).toEqual({ username: 1, password: 2, otp: -1 });
    expect(detectLoginFields([field("text", "", false)])).toEqual({
      username: -1,
      password: -1,
      otp: -1,
    });
  });
});

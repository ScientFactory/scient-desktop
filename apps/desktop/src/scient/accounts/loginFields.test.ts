import { describe, expect, it } from "vite-plus/test";
import { detectLoginFields, type LoginField } from "@t3tools/shared/scientLoginFields";

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
    ).toEqual({ username: 1, password: 4, otp: 5, other: -1 });
  });
  it("selects email and the last text input before the password as fallbacks", () => {
    expect(detectLoginFields([field("text"), field("email"), field("password")]).username).toBe(1);
    expect(
      detectLoginFields([field("text"), field("text"), field("password"), field("text")]),
    ).toEqual({ username: 1, password: 2, otp: -1, other: -1 });
    expect(detectLoginFields([field("text", "", false)])).toEqual({
      username: -1,
      password: -1,
      otp: -1,
      other: -1,
    });
  });
  it("finds an ID box beside an email box, and an ID box named for the user is no code box", () => {
    const named = (type: string, name: string, label = name): LoginField => ({
      ...field(type),
      name,
      label,
    });
    const tz9 = { ...named("text", "tz9"), minLength: 9, maxLength: 9 };
    expect(detectLoginFields([tz9, named("email", "email")])).toMatchObject({
      username: 1,
      other: 0,
    });
    expect(detectLoginFields([named("text", "full_name"), named("email", "email")])).toMatchObject({
      username: 1,
      other: -1,
    });
    expect(
      detectLoginFields([named("text", "username", "username otp-username"), field("password")]),
    ).toEqual({ username: 0, password: 1, otp: -1, other: -1 });
    expect(
      detectLoginFields([
        named("text", "username"),
        field("password"),
        named("text", "login_code", "login_code Verification code"),
      ]),
    ).toEqual({ username: 0, password: 1, otp: 2, other: -1 });
  });
});

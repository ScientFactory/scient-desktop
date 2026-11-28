import { describe, expect, it } from "vite-plus/test";
import { detectLoginFields, type LoginField } from "@t3tools/shared/scientLoginFields";
import { answerStaySignedIn } from "./loginFields.ts";

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
  it("takes a box labelled as a code for a code box, even masked as a password", () => {
    const labelled = (label: string, name = ""): LoginField => ({
      ...field("password"),
      name,
      label,
    });
    // HUJI's SMS step: one masked box whose visible label says "Temporary code".
    expect(detectLoginFields([labelled("code Temporary code", "code")])).toEqual({
      username: -1,
      password: -1,
      otp: 0,
      other: -1,
    });
    // HUJI's OTP tab: o_password, titled "OTP code".
    expect(
      detectLoginFields([
        { ...field("text"), name: "username", label: "username" },
        labelled("o_password hujicc-otp-password OTP code", "o_password"),
      ]),
    ).toEqual({ username: 0, password: -1, otp: 1, other: -1 });
    // A password named an access code, or with "code" in its help, stays a password.
    for (const [text, autocomplete] of [
      ["Password (code sent if forgotten)", "current-password"],
      ["Access code", ""],
      ["Code d'accès", ""],
    ])
      expect(
        detectLoginFields([
          { ...field("text"), name: "username", label: "username" },
          { ...field("password", autocomplete), name: "secret", label: `secret ${text}`, text },
        ]),
      ).toEqual({ username: 0, password: 1, otp: -1, other: -1 });
    for (const label of ["password Password", "password סיסמה"])
      expect(
        detectLoginFields([
          { ...field("text"), name: "username", label: "username" },
          labelled(label, "password"),
        ]),
      ).toEqual({ username: 0, password: 1, otp: -1, other: -1 });
  });
});

describe("answerStaySignedIn", () => {
  /** Microsoft's page after a sign-in: "Don't show this again", No and Yes. */
  const kmsi = (origin = "https://login.microsoftonline.com") => {
    const clicked: string[] = [];
    const element = (name: string, extra: Record<string, unknown> = {}) => ({
      textContent: name,
      value: "",
      click: () => void clicked.push(name),
      ...extra,
    });
    const box = element("don't show again", {
      checked: false,
      disabled: false,
      name: "DontShowAgain",
    });
    const buttons = [element("No"), element("Yes")];
    const page = {
      origin,
      document: {
        body: { innerText: "Stay signed in?\nDon't show this again" },
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
          (selector.includes("checkbox") ? [box] : buttons) as never,
      },
    };
    const login = {
      visible: () => true,
      rememberBox: (boxes: ReadonlyArray<unknown>) => boxes[0],
    } as unknown as Parameters<typeof answerStaySignedIn>[3];
    return { page, login, clicked };
  };

  it("ticks Don't show this again and answers Yes, on the sign-in's own origin only", () => {
    const here = kmsi();
    expect(
      answerStaySignedIn(here.page, "https://login.microsoftonline.com", undefined, here.login),
    ).toBe(true);
    expect(here.clicked).toEqual(["don't show again", "Yes"]);
    const elsewhere = kmsi("https://evil.example");
    expect(
      answerStaySignedIn(
        elsewhere.page,
        "https://login.microsoftonline.com",
        undefined,
        elsewhere.login,
      ),
    ).toBe(false);
    expect(elsewhere.clicked).toEqual([]);
  });
});

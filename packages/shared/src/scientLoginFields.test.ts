import { expect, it, vi } from "vite-plus/test";
import {
  collectLoginFields,
  loginFieldsKitSource,
  type LoginFieldsKit,
} from "./scientLoginFields.ts";

function input(
  type: string,
  options: {
    name?: string;
    autocomplete?: string;
    visible?: boolean;
    inputMode?: string;
    maxLength?: number;
  } = {},
) {
  return {
    type,
    autocomplete: options.autocomplete ?? "",
    disabled: false,
    readOnly: false,
    name: options.name ?? "",
    id: "",
    placeholder: "",
    inputMode: options.inputMode ?? "",
    maxLength: options.maxLength ?? -1,
    closest: () => null,
    getAttribute: () => null,
    getClientRects: vi.fn(() => ({ length: options.visible === false ? 0 : 1 })),
  };
}

function styles() {
  const read = vi.fn(() => ({ visibility: "visible", display: "block" }));
  vi.stubGlobal("getComputedStyle", read);
  return { read, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

it("does not force layout for ordinary page inputs, including in the injected page script", () => {
  using current = styles();
  const fields = [
    input("search"),
    input("text", { inputMode: "numeric" }),
    input("text", { name: "filter" }),
  ];
  const injected = new Function(`return ${loginFieldsKitSource}`)() as LoginFieldsKit;
  for (const collect of [collectLoginFields, injected.collect]) {
    const result = collect(fields);
    expect([result.username, result.password, result.otp]).toEqual([-1, -1, -1]);
  }
  expect(current.read).not.toHaveBeenCalled();
  for (const field of fields) expect(field.getClientRects).not.toHaveBeenCalled();
});

it.each([
  { fields: [input("email")], expected: [0, -1, -1] },
  { fields: [input("password")], expected: [-1, 0, -1] },
  { fields: [input("text", { autocomplete: "one-time-code" })], expected: [-1, -1, 0] },
])("still measures and detects a real sign-in step: $expected", ({ fields, expected }) => {
  using current = styles();
  const detected = collectLoginFields(fields);
  expect([detected.username, detected.password, detected.otp]).toEqual(expected);
  expect(current.read).toHaveBeenCalled();
});

it("applies registration-page refusal after visibility, so hidden fields cannot suppress a login", () => {
  using _current = styles();
  const username = input("text", { name: "username" });
  const hidden = input("password", { visible: false });
  const password = input("password");
  const detected = collectLoginFields([username, hidden, password], {
    refuseNewPasswordPage: true,
  });
  expect([detected.username, detected.password]).toEqual([0, 2]);
  const registration = collectLoginFields([username, input("password"), password], {
    refuseNewPasswordPage: true,
  });
  expect([registration.username, registration.password]).toEqual([-1, -1]);
});

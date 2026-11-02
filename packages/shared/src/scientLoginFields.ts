// Runs inside web pages through `loginFieldsKitSource`: page globals and each other only.

/** What the detector reads from one input; the optional parts only add evidence. */
export interface LoginField {
  readonly type: string;
  readonly autocomplete: string;
  readonly usable: boolean;
  /** Name, id, placeholder and accessible label, where a code field says what it is. */
  readonly label?: string | undefined;
  /** Name, else id. */
  readonly name?: string | undefined;
  readonly inputMode?: string | undefined;
  readonly maxLength?: number | undefined;
}

export interface LoginFieldRules {
  /** Two password fields or a new-password one mean sign-up or change-password: no username or password. */
  readonly refuseNewPasswordPage?: boolean | undefined;
}

/** The parts of page elements the detector reads, so it needs no DOM types. */
interface PageElement {
  getClientRects(): { readonly length: number };
}

interface PageInput extends PageElement {
  readonly type: string;
  readonly autocomplete: string;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly name: string;
  readonly id: string;
  readonly placeholder: string;
  readonly inputMode: string;
  readonly maxLength: number;
  getAttribute(name: string): string | null;
  closest(selectors: string): unknown;
}

interface PageCheckbox extends PageInput {
  readonly checked: boolean;
  readonly labels: ArrayLike<PageElement & { readonly textContent: string | null }> | null;
}

function loginElementVisible(element: PageElement) {
  const style = (
    globalThis as unknown as {
      getComputedStyle(element: PageElement): {
        readonly visibility: string;
        readonly display: string;
      };
    }
  ).getComputedStyle(element);
  return (
    element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none"
  );
}

/** Indexes of the username, password and one-time-code fields, or -1. */
export function detectLoginFields(fields: ReadonlyArray<LoginField>, rules: LoginFieldRules = {}) {
  const tokens = fields.map((field) => field.autocomplete.split(/\s+/));
  const first = (...tests: ReadonlyArray<(field: LoginField, index: number) => boolean>) => {
    for (const test of tests) {
      const found = fields.findIndex((field, index) => field.usable && test(field, index));
      if (found !== -1) return found;
    }
    return -1;
  };
  const passwords = fields.flatMap((field, index) =>
    field.usable && field.type === "password" ? [index] : [],
  );
  const isNew = (index: number) => tokens[index]?.includes("new-password") === true;
  const refused =
    rules.refuseNewPasswordPage === true && (passwords.length > 1 || passwords.some(isNew));
  const password = refused ? -1 : (passwords.find((index) => !isNew(index)) ?? -1);
  const otp = first(
    (_field, index) => tokens[index]?.includes("one-time-code") === true,
    (field) =>
      field.type !== "password" &&
      field.type !== "email" &&
      /otp|mfa|2fa|two.?factor|verification|one.?time|(auth|security|sms).?code|\bcode\b/i.test(
        field.label ?? "",
      ),
    (field) =>
      field.type !== "password" &&
      field.inputMode === "numeric" &&
      (field.maxLength ?? -1) >= 4 &&
      (field.maxLength ?? -1) <= 8,
  );
  const textual = (field: LoginField, index: number) =>
    index !== otp && ["text", "email", "tel"].includes(field.type);
  const named = first(
    (field, index) =>
      textual(field, index) &&
      (field.type === "email" ||
        tokens[index]?.some((token) => token === "username" || token === "email") === true),
    (field, index) =>
      textual(field, index) && /^(user(name)?|email|login)$/i.test(field.name ?? ""),
  );
  let fallback = -1;
  for (let index = 0; index < password; index++) {
    const field = fields[index];
    if (field?.usable && index !== otp && (field.type === "text" || field.type === "tel"))
      fallback = index;
  }
  const username = refused ? -1 : named === -1 ? fallback : named;
  return { username, password, otp };
}

/** The login fields among a page's or a form's inputs, as indexes into `inputs`. */
export function collectLoginFields<Input extends PageInput>(
  inputs: ReadonlyArray<Input>,
  rules: LoginFieldRules = {},
) {
  const fields = inputs.map((input) => ({
    type: input.type,
    autocomplete: input.autocomplete.toLowerCase(),
    usable:
      !input.disabled &&
      !input.readOnly &&
      input.type !== "hidden" &&
      !input.closest("[hidden], [inert]") &&
      loginElementVisible(input),
    label: [input.name, input.id, input.placeholder, input.getAttribute("aria-label")].join(" "),
    name: input.name || input.id,
    inputMode: input.inputMode,
    maxLength: input.maxLength,
  }));
  return { inputs, ...detectLoginFields(fields, rules) };
}

/**
 * An unticked "remember me" or "trust this device" box, never a shared-computer one. With
 * `visibleOnly`, a hidden box still counts when its label shows, as styled checkboxes do.
 */
function findRememberBox<Box extends PageCheckbox>(
  boxes: ReadonlyArray<Box>,
  remember: RegExp,
  forget: RegExp,
  visibleOnly: boolean,
) {
  return boxes.find((box) => {
    const labels = Array.from(box.labels ?? []);
    const label = [
      box.name,
      box.id,
      box.placeholder,
      box.getAttribute("aria-label"),
      ...labels.map((item) => item.textContent),
    ].join(" ");
    return (
      !box.checked &&
      !box.disabled &&
      (!visibleOnly ||
        loginElementVisible(box) ||
        labels.some((item) => loginElementVisible(item))) &&
      remember.test(label) &&
      !forget.test(label)
    );
  });
}

export const loginFieldsKit = {
  visible: loginElementVisible,
  collect: collectLoginFields,
  rememberBox: findRememberBox,
};
export type LoginFieldsKit = typeof loginFieldsKit;

/** `loginFieldsKit` as a page-script expression; `.name` keeps any bundler rename. */
export const loginFieldsKitSource = `(() => { ${loginElementVisible.toString()} ${detectLoginFields.toString()} ${collectLoginFields.toString()} ${findRememberBox.toString()} return { visible: ${loginElementVisible.name}, collect: ${collectLoginFields.name}, rememberBox: ${findRememberBox.name} }; })()`;

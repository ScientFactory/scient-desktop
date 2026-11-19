// Runs inside web pages through `loginFieldsKitSource`: page globals and each other only.

/** What the detector reads from one input; the optional parts only add evidence. */
export interface LoginField {
  readonly type: string;
  readonly autocomplete: string;
  readonly usable: boolean;
  /** Name, id, placeholder and accessible label, where a code field says what it is. */
  readonly label?: string | undefined;
  /** What a person reads for the box: placeholder, labels and title, without name or id. */
  readonly text?: string | undefined;
  /** Name, else id. */
  readonly name?: string | undefined;
  readonly inputMode?: string | undefined;
  readonly maxLength?: number | undefined;
  readonly minLength?: number | undefined;
  readonly pattern?: string | undefined;
}

/** What a username box accepts, from its own type and constraints. */
export interface LoginBox {
  readonly email: boolean;
  readonly minLength: number;
  readonly maxLength: number;
  readonly pattern: string;
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
  readonly minLength: number;
  readonly maxLength: number;
  readonly pattern: string;
  readonly title: string;
  readonly labels: ArrayLike<PageElement & { readonly textContent: string | null }> | null;
  getAttribute(name: string): string | null;
  closest(selectors: string): unknown;
}

interface PageCheckbox extends PageInput {
  readonly checked: boolean;
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

/**
 * Indexes of the username, password and one-time-code fields, or -1. `other` is a second box for
 * who the user is, beside the username: an ID box beside an email box, or the reverse.
 */
export function detectLoginFields(fields: ReadonlyArray<LoginField>, rules: LoginFieldRules = {}) {
  const tokens = fields.map((field) => field.autocomplete.split(/\s+/));
  // A box labelled as a code takes only a one-time code. A masked one needs explicit one-time
  // evidence and no word of a password, since "Access code" can be a password too.
  const isCode = (field: LoginField, index: number) => {
    const marks = tokens[index] ?? [];
    if (marks.includes("one-time-code")) return true;
    if (marks.includes("current-password") || marks.includes("new-password")) return false;
    if (field.type === "email" || /^(user(name)?|login)$/i.test(field.name ?? "")) return false;
    const label = field.label ?? "";
    if (field.type !== "password")
      return /otp|mfa|2fa|two.?factor|verification|one.?time|temporary|sms|\bcode\b|קוד/i.test(
        label,
      );
    return (
      /otp|mfa|2fa|two.?factor|one.?time|(temporary|sms|verification).?code|קוד זמני/i.test(
        label,
      ) && !/password|passwort|kennwort|mot de passe|contraseña|סיסמ/i.test(field.text ?? "")
    );
  };
  const first = (...tests: ReadonlyArray<(field: LoginField, index: number) => boolean>) => {
    for (const test of tests) {
      const found = fields.findIndex((field, index) => field.usable && test(field, index));
      if (found !== -1) return found;
    }
    return -1;
  };
  const passwords = fields.flatMap((field, index) =>
    field.usable && field.type === "password" && !isCode(field, index) ? [index] : [],
  );
  const isNew = (index: number) => tokens[index]?.includes("new-password") === true;
  const refused =
    rules.refuseNewPasswordPage === true && (passwords.length > 1 || passwords.some(isNew));
  const password = refused ? -1 : (passwords.find((index) => !isNew(index)) ?? -1);
  const otp = first(
    (_field, index) => tokens[index]?.includes("one-time-code") === true,
    isCode,
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
  const isEmail = (field: LoginField | undefined, index: number) =>
    field?.type === "email" ||
    tokens[index]?.includes("email") === true ||
    /^e-?mail$/i.test(field?.name ?? "");
  const emailUsername = isEmail(fields[username], username);
  // A second box must say it identifies the person, or be shaped like an ID; never a name or phone.
  const identifies = (field: LoginField, index: number) => {
    const label = field.label ?? "";
    if (tokens[index]?.includes("username") || /user|login|(^|[^a-z\d])id($|[^a-z\d])/i.test(label))
      return true;
    const shaped =
      Boolean(field.pattern) ||
      ((field.minLength ?? -1) > 0 && field.minLength === field.maxLength);
    return shaped && field.type !== "tel" && !/name|phone|mobile|address|zip|postal/i.test(label);
  };
  // An ID box comes before the email box; either comes before the password.
  const other =
    username === -1
      ? -1
      : first(
          (field, index) =>
            index !== username &&
            textual(field, index) &&
            isEmail(field, index) !== emailUsername &&
            identifies(field, index) &&
            (!emailUsername || index < username) &&
            (password === -1 || index < password),
        );
  return { username, password, otp, other };
}

/** A box's own type and constraints, as `loginValueFits` reads them. */
function loginBox(input: {
  readonly type: string;
  readonly autocomplete: string;
  readonly name: string;
  readonly minLength: number;
  readonly maxLength: number;
  readonly pattern: string;
}): LoginBox {
  return {
    email:
      input.type === "email" ||
      input.autocomplete.toLowerCase().split(/\s+/).includes("email") ||
      /^e-?mail$/i.test(input.name),
    minLength: input.minLength,
    maxLength: input.maxLength,
    pattern: input.pattern,
  };
}

/**
 * Whether a saved username fits a box, within its limits: never a non-email in an email box.
 * `exact` also keeps an email out of a box that isn't for one, for choosing the best box first.
 */
export function loginValueFits(box: LoginBox, value: string, exact = false) {
  const email = /^[^\s@]+@[^\s@]+$/.test(value);
  if (box.email ? !email : exact && email) return false;
  if (box.maxLength > 0 && value.length > box.maxLength) return false;
  if (box.minLength > 0 && value.length < box.minLength) return false;
  if (!box.pattern) return true;
  try {
    return new RegExp(`^(?:${box.pattern})$`, "v").test(value);
  } catch {
    return true;
  }
}

/** The login fields among a page's or a form's inputs, as indexes into `inputs`. */
export function collectLoginFields<Input extends PageInput>(
  inputs: ReadonlyArray<Input>,
  rules: LoginFieldRules = {},
) {
  const fields = inputs.map((input) => {
    // What a person reads beside the box: placeholder, aria label, title, labels, labelledby.
    const text = [
      input.placeholder,
      input.getAttribute("aria-label"),
      input.title,
      ...Array.from(input.labels ?? [], (label) => label.textContent),
      ...(input.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(
        (id) =>
          id &&
          (
            globalThis as unknown as {
              document: { getElementById(id: string): { textContent: string | null } | null };
            }
          ).document.getElementById(id)?.textContent,
      ),
    ].join(" ");
    return {
      type: input.type,
      autocomplete: input.autocomplete.toLowerCase(),
      usable:
        !input.disabled &&
        !input.readOnly &&
        input.type !== "hidden" &&
        !input.closest("[hidden], [inert]") &&
        loginElementVisible(input),
      label: [input.name, input.id, text].join(" "),
      text,
      name: input.name || input.id,
      inputMode: input.inputMode,
      maxLength: input.maxLength,
      minLength: input.minLength,
      pattern: input.pattern,
    };
  });
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
  box: loginBox,
  fits: loginValueFits,
};
export type LoginFieldsKit = typeof loginFieldsKit;

/** `loginFieldsKit` as a page-script expression; `.name` keeps any bundler rename. */
export const loginFieldsKitSource = `(() => { ${loginElementVisible.toString()} ${detectLoginFields.toString()} ${collectLoginFields.toString()} ${findRememberBox.toString()} ${loginBox.toString()} ${loginValueFits.toString()} return { visible: ${loginElementVisible.name}, collect: ${collectLoginFields.name}, rememberBox: ${findRememberBox.name}, box: ${loginBox.name}, fits: ${loginValueFits.name} }; })()`;

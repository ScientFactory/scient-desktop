import {
  loginFieldsKit,
  loginFieldsKitSource,
  type LoginFieldsKit,
} from "@t3tools/shared/scientLoginFields";
import { FORGET_SIGN_IN_LABEL, REMEMBER_SIGN_IN_LABEL } from "@t3tools/shared/scientSignInPage";

function fillLoginForm(
  values: {
    username?: string | undefined;
    password?: string | undefined;
    otp?: string | undefined;
  },
  expectedOrigin: string,
  options: {
    documentId?: string | undefined;
    automatic?: boolean | undefined;
    submit?: boolean | undefined;
  } = {},
  labels = { remember: REMEMBER_SIGN_IN_LABEL, forget: FORGET_SIGN_IN_LABEL },
  login: LoginFieldsKit = loginFieldsKit,
) {
  if (location.origin !== expectedOrigin || (options.automatic && !options.documentId))
    return false;
  const state = loginDocumentState();
  if (options.documentId !== undefined && state?.documentId !== options.documentId) return false;
  if (options.automatic && (!state || state.autoFilled || state.userEdited)) return false;
  const roots = [...Array.from(document.forms), document];
  const candidates = roots.map((root) => login.collect(Array.from(root.querySelectorAll("input"))));
  const priority = (candidate: (typeof candidates)[number]) =>
    values.password !== undefined && candidate.password !== -1
      ? 3
      : values.otp !== undefined && candidate.otp !== -1
        ? 2
        : values.username !== undefined && candidate.username !== -1
          ? 1
          : 0;
  candidates.sort((a, b) => priority(b) - priority(a));
  for (const detected of candidates) {
    if (priority(detected) === 0) continue;
    if (
      options.automatic &&
      [detected.username, detected.password, detected.otp].some((index) =>
        Boolean(detected.inputs[index]?.value),
      )
    )
      return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return false;
    let filled = false;
    for (const key of ["username", "password", "otp"] as const) {
      const input = detected.inputs[detected[key]];
      const value = values[key];
      if (!input || value === undefined) continue;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      filled = true;
    }
    if (filled) {
      if (values.password !== undefined || values.otp !== undefined)
        login
          .rememberBox(
            Array.from(document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")),
            new RegExp(labels.remember, "i"),
            new RegExp(labels.forget, "i"),
            false,
          )
          ?.click();
      if (options.automatic && state) state.autoFilled = true;
      // Only a complete sign-in: a username step still needs the user's page to move on.
      const form = detected.inputs[detected.password]?.form;
      if (
        form &&
        options.submit &&
        values.username !== undefined &&
        values.password !== undefined &&
        detected.username !== -1
      ) {
        form.requestSubmit();
        return "submitted";
      }
      return true;
    }
  }
  return false;
}

export const loginFillScript = (
  values: {
    username?: string | undefined;
    password?: string | undefined;
    otp?: string | undefined;
  },
  origin: string,
  options: {
    documentId?: string | undefined;
    automatic?: boolean | undefined;
    submit?: boolean | undefined;
  } = {},
) =>
  `(() => { const loginDocumentState = ${loginDocumentState.toString()}; return (${fillLoginForm.toString()})(${JSON.stringify(values)}, ${JSON.stringify(origin)}, ${JSON.stringify(options)}, ${JSON.stringify({ remember: REMEMBER_SIGN_IN_LABEL, forget: FORGET_SIGN_IN_LABEL })}, ${loginFieldsKitSource}); })()`;

export interface LoginDocumentState {
  readonly documentId: string;
  userEdited: boolean;
  autoFilled: boolean;
}

export function loginDocumentState() {
  // Preview webviews disable context isolation, so the preload, report and fill share the page's world.
  return (globalThis as typeof globalThis & { __scientAccountsLogin?: LoginDocumentState })
    .__scientAccountsLogin;
}

export function loginFormReport(login: LoginFieldsKit = loginFieldsKit) {
  const state = loginDocumentState();
  if (!state || document.readyState === "loading") return null;
  const fields = login.collect(Array.from(document.querySelectorAll("input")));
  if (fields.username === -1 && fields.password === -1) return null;
  return {
    url: location.origin,
    documentId: state.documentId,
    userEdited: state.userEdited,
    hasPassword: fields.password !== -1,
    hasValues: [fields.username, fields.password, fields.otp].some((index) =>
      Boolean(fields.inputs[index]?.value),
    ),
  };
}

export const loginFormReportScript = `(() => { const loginDocumentState = ${loginDocumentState.toString()}; return (${loginFormReport.toString()})(${loginFieldsKitSource}); })()`;

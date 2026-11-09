import {
  loginFieldsKit,
  loginFieldsKitSource,
  type LoginFieldsKit,
} from "@t3tools/shared/scientLoginFields";
import { FORGET_SIGN_IN_LABEL, REMEMBER_SIGN_IN_LABEL } from "@t3tools/shared/scientSignInPage";

function fillLoginForm(
  values: {
    username?: string | undefined;
    /** Another saved username for the page's second box: an email beside an ID, or the reverse. */
    otherUsername?: string | undefined;
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
  if (options.automatic && !state) return false;
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
    const boxes = [detected.username, detected.other].flatMap((index) => {
      const input = detected.inputs[index];
      return input ? [input] : [];
    });
    // Never over what the user typed or cleared, and each box filled automatically once.
    if (
      options.automatic &&
      [...boxes, detected.inputs[detected.password], detected.inputs[detected.otp]].some(
        (input) =>
          input !== undefined &&
          (Boolean(input.value) || state?.edited.has(input) || state?.filled.has(input)),
      )
    )
      return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return false;
    const targets: Array<readonly [HTMLInputElement, string]> = [];
    // Each username goes only into a box it fits, the one made for it first.
    for (const value of [values.username, values.otherUsername]) {
      if (value === undefined) continue;
      const fits = (exact: boolean) => (input: HTMLInputElement) =>
        !targets.some(([taken]) => taken === input) && login.fits(login.box(input), value, exact);
      const input = boxes.find(fits(true)) ?? boxes.find(fits(false));
      if (input) targets.push([input, value]);
    }
    const usernameBox = detected.inputs[detected.username];
    // Never a password for another username than the one left in the username box.
    if (
      values.password !== undefined &&
      usernameBox?.value &&
      usernameBox.value !== values.username &&
      !targets.some(([input]) => input === usernameBox)
    )
      return false;
    for (const key of ["password", "otp"] as const) {
      const input = detected.inputs[detected[key]];
      const value = values[key];
      if (input && value !== undefined) targets.push([input, value]);
    }
    for (const [input, value] of targets) {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (options.automatic) state?.filled.add(input);
    }
    if (targets.length > 0) {
      if (values.password !== undefined || values.otp !== undefined)
        login
          .rememberBox(
            Array.from(document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")),
            new RegExp(labels.remember, "i"),
            new RegExp(labels.forget, "i"),
            false,
          )
          ?.click();
      // Only a complete sign-in: a username step still needs the user's page to move on.
      const form = detected.inputs[detected.password]?.form;
      if (
        form &&
        options.submit &&
        values.password !== undefined &&
        targets.some(([input]) => input === detected.inputs[detected.username])
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
    otherUsername?: string | undefined;
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
  /** Boxes the user typed in, cleared included. */
  readonly edited: WeakSet<EventTarget>;
  /** Boxes Scient filled automatically. */
  readonly filled: WeakSet<EventTarget>;
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
  const indexes = [fields.username, fields.other, fields.password, fields.otp];
  const inputs = indexes.flatMap((index) => {
    const input = fields.inputs[index];
    return input ? [input] : [];
  });
  return {
    url: location.origin,
    documentId: state.documentId,
    /** Which boxes show: a new set is a new chance to fill, as when a page switches tabs. */
    fields: indexes.join(","),
    userEdited: inputs.some((input) => state.edited.has(input)),
    hasPassword: fields.password !== -1,
    hasValues: inputs.some((input) => Boolean(input.value)),
    boxes: [fields.username, fields.other].flatMap((index) => {
      const input = fields.inputs[index];
      return input ? [login.box(input)] : [];
    }),
  };
}

export const loginFormReportScript = `(() => { const loginDocumentState = ${loginDocumentState.toString()}; return (${loginFormReport.toString()})(${loginFieldsKitSource}); })()`;

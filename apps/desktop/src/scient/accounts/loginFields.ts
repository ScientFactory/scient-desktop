import type { AccountPageOffer } from "@t3tools/contracts";
import {
  loginFieldsKit,
  loginFieldsKitSource,
  type LoginFieldsKit,
} from "@t3tools/shared/scientLoginFields";
import { setupPageScript } from "@t3tools/shared/scientSetupPage";
import {
  FORGET_SIGN_IN_LABEL,
  REMEMBER_SIGN_IN_LABEL,
  SITE_LIMITED_TEXT,
} from "@t3tools/shared/scientSignInPage";

function fillLoginForm(
  values: {
    username?: string | undefined;
    /** Another saved username for the page's second box: an email beside an ID, or the reverse. */
    otherUsername?: string | undefined;
    password?: string | undefined;
    otp?: string | undefined;
    /** Fill `otp` only over this code, still in the code box (Scient's own earlier one). */
    otpExpected?: string | undefined;
    /** Fill `password` over this one, still in the box as Scient typed it (a refused one). */
    passwordExpected?: string | undefined;
    /** A sign-up or change form's new password; `password` then goes in its current box. */
    newPassword?: string | undefined;
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
  const fresh = values.newPassword;
  if (fresh !== undefined) {
    // One form only: the first new-password box's (without a form, its nearest container with a
    // submit-like button after the box, a few levels up and never the body: a search or menu
    // button, or one above the boxes, makes none; none, nothing), and its own boxes; one naming
    // another account than `username` gets nothing.
    const [first] = login.newPasswordBoxes(Array.from(document.querySelectorAll("input")));
    const submits = (node: Element) =>
      Array.from(node.querySelectorAll('button, input[type="submit"]')).some((control) => {
        const said = `${control.textContent ?? ""} ${(control as HTMLInputElement).value ?? ""} ${
          control.getAttribute("aria-label") ?? ""
        }`;
        return (
          first !== undefined &&
          (first.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          (control.getAttribute("type") === "submit" ||
            /\b(?:change|update|save|set|reset|submit|confirm|continue|done)\b/i.test(said))
        );
      });
    let root: ParentNode | null = first?.form ?? null;
    let node = first?.parentElement;
    for (let level = 0; !root && node && level < 4; level++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      if (submits(node)) root = node;
    }
    if (!root) return false;
    const inputs = Array.from(root.querySelectorAll("input"));
    const boxes = login.newPasswordBoxes(inputs);
    const named = login.collect(inputs);
    const shown = [named.inputs[named.username], named.inputs[named.other]].flatMap((input) =>
      input?.value.trim() ? [input.value.trim().toLowerCase()] : [],
    );
    if (
      values.username !== undefined &&
      shown.length > 0 &&
      !shown.includes(values.username.trim().toLowerCase())
    )
      return false;
    // A formless container is the change form's own only when every box it shows is one of a
    // change form's (a username, passwords): a wrapper around other boxes (a search) isn't.
    const own = new Set([named.inputs[named.username], named.inputs[named.other]]);
    if (
      !first?.form &&
      inputs.some(
        (input) =>
          login.visible(input) &&
          input.type !== "password" &&
          input.type !== "hidden" &&
          !own.has(input),
      )
    )
      return false;
    const current = inputs.find(
      (input) =>
        values.password !== undefined &&
        input.type === "password" &&
        !input.value &&
        !boxes.includes(input) &&
        login.visible(input),
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (boxes.length === 0 || !setter) return false;
    const targets = boxes.map((box) => [box, fresh] as const);
    for (const [input, value] of current
      ? [...targets, [current, values.password!] as const]
      : targets) {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }
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
    // Never over what the user typed or cleared, and each box filled automatically once; but a
    // password Scient typed and the person left as it was (`passwordExpected`) is replaced.
    const passwordBox = detected.inputs[detected.password];
    const replaceable = (input: HTMLInputElement) =>
      values.passwordExpected !== undefined &&
      !state?.edited.has(input) &&
      (input === passwordBox
        ? input.value === values.passwordExpected
        : !input.value || input.value === values.username || input.value === values.otherUsername);
    if (
      options.automatic &&
      [...boxes, passwordBox, detected.inputs[detected.otp]].some(
        (input) =>
          input !== undefined &&
          (Boolean(input.value) || state?.edited.has(input) || state?.filled.has(input)) &&
          !replaceable(input),
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
    // The login the person chose goes in whole; an automatic fill whose username fits no box
    // fills nothing, never its password alone.
    const placed = targets.some(([, value]) => value === values.username);
    if (values.username !== undefined && usernameBox && !placed) {
      if (options.automatic) return false;
      if (!usernameBox.value) targets.push([usernameBox, values.username]);
    }
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
    // A refreshed code replaces only Scient's own earlier one, never what the person typed.
    const codeBox = detected.inputs[detected.otp];
    // An empty box (the person cleared it for a fresh one) takes the new code too.
    if (
      values.otpExpected !== undefined &&
      codeBox?.value !== values.otpExpected &&
      codeBox?.value !== ""
    )
      return false;
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

/**
 * Microsoft's "Stay signed in?" right after Scient filled this tab's sign-in, on the same
 * origin: ticks "Don't show this again" and answers Yes, as Scient's own sign-in does.
 */
export function answerStaySignedIn(
  page: {
    readonly document: Pick<Document, "querySelector" | "querySelectorAll"> & {
      readonly body: { readonly innerText: string } | null;
    };
    readonly origin: string;
  },
  expectedOrigin: string,
  labels = { remember: REMEMBER_SIGN_IN_LABEL, forget: FORGET_SIGN_IN_LABEL },
  login: Pick<LoginFieldsKit, "visible" | "rememberBox"> = loginFieldsKit,
) {
  const { document } = page;
  if (page.origin !== expectedOrigin || document.querySelector("input[type=password]"))
    return false;
  if (!/stay signed in\?/i.test(document.body?.innerText ?? "")) return false;
  const yes = Array.from(
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input[type=submit]"),
  ).find(
    (element) =>
      login.visible(element) &&
      /^yes$/i.test(
        ("value" in element && element.value ? element.value : (element.textContent ?? "")).trim(),
      ),
  );
  if (!yes) return false;
  login
    .rememberBox(
      Array.from(document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")),
      new RegExp(labels.remember, "i"),
      new RegExp(labels.forget, "i"),
      true,
    )
    ?.click();
  yes.click();
  return true;
}

export const staySignedInScript = (origin: string) =>
  `(${answerStaySignedIn.toString()})({ document, origin: location.origin }, ${JSON.stringify(origin)}, ${JSON.stringify({ remember: REMEMBER_SIGN_IN_LABEL, forget: FORGET_SIGN_IN_LABEL })}, ${loginFieldsKitSource})`;

export const loginFillScript = (
  values: {
    username?: string | undefined;
    otherUsername?: string | undefined;
    password?: string | undefined;
    otp?: string | undefined;
    otpExpected?: string | undefined;
    passwordExpected?: string | undefined;
    newPassword?: string | undefined;
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

/**
 * The world Electron's context isolation runs preview preloads in. The preload keeps the login
 * state there, so the report and fill scripts run in that world too, not the page's own.
 */
export const PRELOAD_WORLD_ID = 999;

export function loginDocumentState() {
  // The preload, report and fill share the preload's isolated world (PRELOAD_WORLD_ID).
  return (globalThis as typeof globalThis & { __scientAccountsLogin?: LoginDocumentState })
    .__scientAccountsLogin;
}

export function loginFormReport(login: LoginFieldsKit = loginFieldsKit) {
  const state = loginDocumentState();
  if (!state || document.readyState === "loading") return null;
  const fields = login.collect(Array.from(document.querySelectorAll("input")));
  // A 2FA setup page: a code box beside a QR-sized square image, canvas or SVG, or an otpauth link.
  const setup =
    fields.otp !== -1 &&
    (document.querySelector('a[href^="otpauth:" i]') !== null ||
      Array.from(document.querySelectorAll("img, canvas, svg")).some((element) => {
        const box = element.getBoundingClientRect();
        return (
          login.visible(element) &&
          box.width >= 64 &&
          box.width <= 1200 &&
          Math.abs(box.width - box.height) <= 0.2 * box.width
        );
      }));
  // A sign-up or change-password form, with what it says about the password it takes: its words
  // are read here, and only what they state leaves the page.
  const [fresh] = login.newPasswordBoxes(Array.from(document.querySelectorAll("input")));
  const said =
    fresh &&
    login.newPasswordWords(
      (fresh.form ?? fresh.closest("main, section, div") ?? document.body)?.textContent
        ?.replace(/\s+/g, " ")
        .trim()
        .slice(0, 1000) ?? "",
    );
  const newPassword = fresh &&
    said && {
      minLength: fresh.minLength,
      maxLength: fresh.maxLength,
      pattern: fresh.pattern.slice(0, 1024),
      passwordRules: (fresh.getAttribute("passwordrules") ?? "").slice(0, 1024),
      statedMinLength: said.minLength,
      statedMaxLength: said.maxLength,
      required: said.required,
      noSymbols: said.noSymbols,
      refusal: said.refusal,
    };
  // Backup codes, looked for only on a settings or security page, since the text check is costly.
  const codes =
    !setup &&
    /secur|2fa|two.?factor|mfa|recovery|backup|account|setting/i.test(
      `${location.pathname} ${document.title}`,
    ) &&
    login.recoveryCodes().length > 0;
  if (fields.username === -1 && fields.password === -1 && !setup && !newPassword && !codes)
    return null;
  const indexes = [fields.username, fields.other, fields.password, fields.otp];
  const inputs = indexes.flatMap((index) => {
    const input = fields.inputs[index];
    return input ? [input] : [];
  });
  return {
    url: location.origin,
    documentId: state.documentId,
    /** Which boxes show, and what the page offers: a new set is a new chance to fill. */
    fields:
      indexes.join(",") +
      (setup ? ",setup" : "") +
      (codes ? ",codes" : "") +
      (newPassword ? ",new" : ""),
    userEdited: inputs.some((input) => state.edited.has(input)),
    hasPassword: fields.password !== -1,
    hasValues: inputs.some((input) => Boolean(input.value)),
    boxes: [fields.username, fields.other].flatMap((index) => {
      const input = fields.inputs[index];
      return input ? [login.box(input)] : [];
    }),
    ...(setup
      ? { offer: "two-factor-setup" as const }
      : codes
        ? { offer: "recovery-codes" as const }
        : {}),
    ...(newPassword ? { newPassword } : {}),
  };
}

/**
 * Where a sign-in stands on the page: still loading, a username or password box, a code step, or
 * past them all. Only "done" means what was typed worked.
 */
function signInPageState(login: LoginFieldsKit = loginFieldsKit) {
  if (document.readyState !== "complete") return "loading";
  const fields = login.collect(Array.from(document.querySelectorAll("input")));
  if (fields.username !== -1 || fields.password !== -1) return "login";
  return fields.otp === -1 ? "done" : "code";
}

export const signInPageStateScript = `(() => (${signInPageState.toString()})(${loginFieldsKitSource}))()`;

/**
 * The page right after a new-password form's request was answered: whether any change, sign-in
 * or code box still shows, and whether its alert or status regions say the change failed.
 */
function submitPageLook(login: LoginFieldsKit = loginFieldsKit) {
  const inputs = Array.from(document.querySelectorAll("input"));
  const fields = login.collect(inputs);
  const formGone =
    login.newPasswordBoxes(inputs).every((input) => !login.visible(input)) &&
    fields.username === -1 &&
    fields.password === -1 &&
    fields.otp === -1;
  const said = Array.from(
    document.querySelectorAll(
      '[role="alert"], [role="status"], [aria-live], [aria-invalid="true"]',
    ),
  )
    .filter((element) => login.visible(element))
    .map((element) => element.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 1000);
  return {
    formGone,
    refusal: login.newPasswordWords(said).refusal,
    origin: location.origin,
    documentId: loginDocumentState()?.documentId ?? null,
  };
}

export const submitPageLookScript = `(() => { const loginDocumentState = ${loginDocumentState.toString()}; return (${submitPageLook.toString()})(${loginFieldsKitSource}); })()`;

/** The page's own document came back as an HTTP error, such as a refused form's 400 or a 404. */
export const documentFailedScript = `(() => (performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0) >= 400)()`;

/** The page says the site is limiting sign-ins (too many attempts, a lockout). */
export const pageLimitedScript = `(() => new RegExp(${JSON.stringify(SITE_LIMITED_TEXT)}, "i").test(document.body?.innerText ?? ""))()`;

/** The page's document as the form reports name it (`LoginDocumentState`); null before one. */
export const documentIdScript = `(() => { const loginDocumentState = ${loginDocumentState.toString()}; return loginDocumentState()?.documentId ?? null; })()`;

export const loginFormReportScript = `(() => { const loginDocumentState = ${loginDocumentState.toString()}; return (${loginFormReport.toString()})(${loginFieldsKitSource}); })()`;

/**
 * What a 2FA setup or backup-code page shows, read only in the document the form report named:
 * null in any other (the tab moved on).
 */
export const pageSecretsScript = (offer: AccountPageOffer, documentId: string) =>
  `(() => { const loginDocumentState = ${loginDocumentState.toString()}; if (loginDocumentState()?.documentId !== ${JSON.stringify(documentId)}) return null; return { origin: location.origin, ${
    offer === "two-factor-setup"
      ? `setup: ${setupPageScript}`
      : `codes: (${loginFieldsKitSource}).recoveryCodes()`
  } }; })()`;

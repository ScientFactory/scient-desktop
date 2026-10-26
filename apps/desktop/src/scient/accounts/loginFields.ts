export interface LoginField {
  readonly type: string;
  readonly autocomplete: string;
  readonly usable: boolean;
}

export function detectLoginFields(fields: ReadonlyArray<LoginField>) {
  const password = fields.findIndex(
    (field) =>
      field.usable &&
      field.type === "password" &&
      !field.autocomplete.split(/\s+/).includes("new-password"),
  );
  const otp = fields.findIndex(
    (field) => field.usable && field.autocomplete.split(/\s+/).includes("one-time-code"),
  );
  const username = fields.findIndex(
    (field, index) =>
      field.usable &&
      index !== otp &&
      ["text", "email", "tel"].includes(field.type) &&
      (field.autocomplete.split(/\s+/).some((token) => token === "username" || token === "email") ||
        field.type === "email"),
  );
  let fallback = -1;
  for (let index = 0; index < password; index++) {
    if (fields[index]?.usable && fields[index]?.type === "text" && index !== otp) fallback = index;
  }
  return { username: username === -1 ? fallback : username, password, otp };
}

export function collectLoginFields(root: ParentNode) {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input"));
  const fields = inputs.map((input) => ({
    type: input.type,
    autocomplete: input.autocomplete.toLowerCase(),
    usable:
      !input.disabled &&
      !input.readOnly &&
      input.type !== "hidden" &&
      !input.closest("[hidden], [inert]") &&
      input.getClientRects().length > 0 &&
      getComputedStyle(input).visibility !== "hidden",
  }));
  return { inputs, ...detectLoginFields(fields) };
}

function fillLoginForm(
  values: {
    username?: string | undefined;
    password?: string | undefined;
    otp?: string | undefined;
  },
  expectedOrigin: string,
  options: { documentId?: string | undefined; automatic?: boolean | undefined } = {},
) {
  if (location.origin !== expectedOrigin || (options.automatic && !options.documentId))
    return false;
  const state = loginDocumentState();
  if (options.documentId !== undefined && state?.documentId !== options.documentId) return false;
  if (options.automatic && (!state || state.autoFilled || state.userEdited)) return false;
  const roots = [...Array.from(document.forms), document];
  const candidates = roots.map(collectLoginFields);
  const priority = (candidate: ReturnType<typeof collectLoginFields>) =>
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
      if (options.automatic && state) state.autoFilled = true;
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
  options: { documentId?: string | undefined; automatic?: boolean | undefined } = {},
) =>
  `(() => { const loginDocumentState = ${loginDocumentState.toString()}; const detectLoginFields = ${detectLoginFields.toString()}; const collectLoginFields = ${collectLoginFields.toString()}; return (${fillLoginForm.toString()})(${JSON.stringify(values)}, ${JSON.stringify(origin)}, ${JSON.stringify(options)}); })()`;

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

export function loginFormReport() {
  const state = loginDocumentState();
  if (!state || document.readyState === "loading") return null;
  const fields = collectLoginFields(document);
  if (fields.username === -1 && fields.password === -1) return null;
  return {
    url: location.origin,
    documentId: state.documentId,
    userEdited: state.userEdited,
    hasValues: [fields.username, fields.password, fields.otp].some((index) =>
      Boolean(fields.inputs[index]?.value),
    ),
  };
}

export const loginFormReportScript = `(() => { const loginDocumentState = ${loginDocumentState.toString()}; const detectLoginFields = ${detectLoginFields.toString()}; const collectLoginFields = ${collectLoginFields.toString()}; return (${loginFormReport.toString()})(); })()`;

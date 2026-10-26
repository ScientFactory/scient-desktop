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
) {
  if (location.origin !== expectedOrigin) return false;
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
    if (filled) return true;
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
) =>
  `(() => { const detectLoginFields = ${detectLoginFields.toString()}; const collectLoginFields = ${collectLoginFields.toString()}; return (${fillLoginForm.toString()})(${JSON.stringify(values)}, ${JSON.stringify(origin)}); })()`;

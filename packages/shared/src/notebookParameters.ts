import type { NotebookCellView } from "@t3tools/contracts";

type Literal = string | number | boolean | Literal[];
type Language = "python" | "r" | "julia";

interface Parameter {
  readonly name: string;
  readonly value: Literal | undefined;
  readonly defaultJson: string | undefined;
  readonly numericKind: "integer" | "decimal" | undefined;
  readonly collection: "vector" | "list" | null;
}

export function notebookParameterLanguage(language: string): Language | undefined {
  const normalized = language.toLowerCase();
  if (normalized === "python" || normalized === "r" || normalized === "julia") return normalized;
  return undefined;
}

const NUMBER =
  /^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?$|^[+-]?\.[0-9]+(?:[eE][+-]?[0-9]+)?$/u;
const ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  '"': '"',
  "'": "'",
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
};

function stringValue(token: string, language: Language): string | undefined {
  if (token.startsWith(token.charAt(0).repeat(3))) return undefined;
  if (
    language === "julia" &&
    (token.startsWith("'") || token.slice(1, -1).replace(/\\./gu, "").includes("$"))
  ) {
    return undefined;
  }
  return token.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/gu, (_whole, char: string) => {
    if (char.length === 5) return String.fromCharCode(Number.parseInt(char.slice(1), 16));
    if (language === "julia" && char === "$") return "$";
    const escaped = ESCAPES[char];
    if (escaped === undefined) throw new Error("Unsupported escape");
    return escaped;
  });
}

function numberJson(value: number, decimal: boolean): string {
  const encoded = Object.is(value, -0) ? "-0" : JSON.stringify(value);
  return decimal && !/[.eE]/u.test(encoded) ? `${encoded}.0` : encoded;
}

export function notebookParameterJson(parameter: Parameter, value: Literal): string {
  return typeof value === "number"
    ? numberJson(value, parameter.numericKind === "decimal")
    : JSON.stringify(value);
}

function readLiteral(
  tokens: ReadonlyArray<string>,
  cursor: { index: number },
  language: Language,
  depth = 0,
): { readonly value: Literal; readonly json: string } {
  const token = tokens[cursor.index++];
  if (token === undefined || depth > 16) throw new Error("Expected a literal");
  if (token.startsWith('"') || token.startsWith("'")) {
    const value = stringValue(token, language);
    if (value !== undefined) return { value, json: JSON.stringify(value) };
  } else if (NUMBER.test(token)) {
    const value = Number(token);
    if (Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) {
      return {
        value,
        json:
          parseNotebookOverride(token) === undefined
            ? numberJson(value, /[.eE]/u.test(token))
            : token,
      };
    }
  } else if (token === { python: "True", r: "TRUE", julia: "true" }[language]) {
    return { value: true, json: "true" };
  } else if (token === { python: "False", r: "FALSE", julia: "false" }[language]) {
    return { value: false, json: "false" };
  } else if (
    (token === "[" && language !== "r") ||
    (language === "r" && (token === "c" || token === "list") && tokens[cursor.index++] === "(")
  ) {
    const closing = language === "r" ? ")" : "]";
    const values: Literal[] = [];
    const items: string[] = [];
    while (tokens[cursor.index] !== closing) {
      const item = readLiteral(tokens, cursor, language, depth + 1);
      values.push(item.value);
      items.push(item.json);
      if (tokens[cursor.index] === closing) break;
      if (tokens[cursor.index++] !== ",") throw new Error("Expected a comma");
      if (language === "r" && tokens[cursor.index] === closing) {
        throw new Error("Missing list element");
      }
    }
    cursor.index += 1;
    if (
      token !== "c" ||
      (values.length > 0 &&
        values.every((value) => !Array.isArray(value) && typeof value === typeof values[0]))
    )
      return { value: values, json: `[${items.join(",")}]` };
  }
  throw new Error("Unsupported literal");
}

/** Deliberately accepts a literal subset. Notebook source never runs to populate a control. */
export function readNotebookParameters(source: string, language: string): ReadonlyArray<Parameter> {
  const dialect = notebookParameterLanguage(language);
  if (dialect === undefined) return [];
  const parameters = new Map<string, Parameter>();
  const grammar =
    /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|#[^\r\n]*|\r?\n|[^\S\r\n]+|[A-Za-z_][\w]*|[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|<<?-|==|[^\r\n]/gu;
  let statement: string[] = [];
  let brackets = 0;
  let indented = false;
  let afterSeparator = false;
  let operator = -1;
  const save = (allowEditing: boolean) => {
    if (dialect === "python" && indented) return;
    const constant = dialect === "julia" && statement[0] === "const";
    const nameAt = constant ? 1 : 0;
    const name = statement[nameAt];
    const plain = operator === nameAt + 1;
    const annotation =
      dialect !== "r" &&
      statement[nameAt + 1] === ":" &&
      (operator > nameAt + 2 || (operator === -1 && statement.length > nameAt + 2));
    if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || (!plain && !annotation))
      return;
    const rhs = operator === -1 ? [] : statement.slice(operator + 1);
    let parsed: ReturnType<typeof readLiteral> | undefined;
    if (allowEditing && !constant) {
      const cursor = { index: 0 };
      try {
        const result = readLiteral(rhs, cursor, dialect);
        if (cursor.index === rhs.length) parsed = result;
      } catch {
        // Expressions stay visible as read-only parameters.
      }
    }
    const value = parsed?.value;
    parameters.set(name, {
      name,
      value,
      defaultJson: parsed?.json,
      numericKind:
        typeof value === "number" ? (/[.eE]/u.test(rhs[0]!) ? "decimal" : "integer") : undefined,
      collection: Array.isArray(value) ? (rhs[0] === "c" ? "vector" : "list") : null,
    });
  };
  for (const [token] of source.matchAll(grammar)) {
    if (token === "\n" || token === "\r\n") {
      if (brackets > 0) continue;
      save(!afterSeparator);
      statement = [];
      indented = false;
      afterSeparator = false;
      operator = -1;
    } else if (token === ";" && brackets === 0) {
      save(false);
      statement = [];
      afterSeparator = true;
      operator = -1;
    } else if (token.trim() === "") {
      if (statement.length === 0 && !afterSeparator) indented = true;
    } else if (!token.startsWith("#")) {
      if (
        brackets === 0 &&
        operator === -1 &&
        (token === "=" || (dialect === "r" && (token === "<-" || token === "<<-")))
      )
        operator = statement.length;
      if (/^[([{]$/u.test(token)) brackets += 1;
      if (/^[)\]}]$/u.test(token)) brackets = Math.max(brackets - 1, 0);
      statement.push(token);
    }
  }
  save(!afterSeparator);
  return [...parameters.values()];
}

function isLiteral(value: unknown, depth = 0): value is Literal {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))) ||
    (Array.isArray(value) && depth < 16 && value.every((item) => isLiteral(item, depth + 1)))
  );
}

export function parseNotebookOverride(json: string): Literal | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return isLiteral(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function notebookOverrideAllowed(parameter: Parameter, value: Literal): boolean {
  const fallback = parameter.value;
  if (fallback === undefined || Array.isArray(fallback) !== Array.isArray(value)) return false;
  if (!Array.isArray(value)) {
    return (
      typeof value === typeof fallback &&
      (parameter.numericKind !== "integer" || Number.isInteger(value))
    );
  }
  if (parameter.collection !== "vector") return true;
  return (
    Array.isArray(fallback) &&
    value.length > 0 &&
    value.every((item) => !Array.isArray(item) && typeof item === typeof fallback[0])
  );
}

type Control =
  | { readonly options: ReadonlyArray<Literal> }
  | { readonly min: number; readonly max: number; readonly step: number };

function parameterControl(raw: unknown, parameter: Parameter): Control | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if ("options" in raw && Array.isArray(raw.options)) {
    const options = raw.options.filter(
      (option: unknown) => isLiteral(option) && notebookOverrideAllowed(parameter, option),
    );
    if (options.length > 0) return { options };
  }
  if (
    typeof parameter.value === "number" &&
    "min" in raw &&
    typeof raw.min === "number" &&
    Number.isFinite(raw.min) &&
    "max" in raw &&
    typeof raw.max === "number" &&
    Number.isFinite(raw.max) &&
    "step" in raw &&
    typeof raw.step === "number" &&
    Number.isFinite(raw.step) &&
    (parameter.numericKind !== "integer" || [raw.min, raw.max, raw.step].every(Number.isInteger)) &&
    raw.min <= parameter.value &&
    raw.max >= parameter.value &&
    raw.min < raw.max &&
    raw.step > 0
  )
    return { min: raw.min, max: raw.max, step: raw.step };
  return undefined;
}

export function notebookParameters(cell: NotebookCellView | undefined, language: string) {
  if (cell === undefined) return [];
  return readNotebookParameters(cell.source, language).map((parameter) => ({
    ...parameter,
    control: parameterControl(
      Object.hasOwn(cell.parameterHints ?? {}, parameter.name)
        ? cell.parameterHints?.[parameter.name]
        : undefined,
      parameter,
    ),
  }));
}

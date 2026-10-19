import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";

const operators: Readonly<Record<string, string>> = {
  lim: "lim",
  limsup: "lim\\,sup",
  liminf: "lim\\,inf",
  max: "max",
  min: "min",
  sup: "sup",
  inf: "inf",
  det: "det",
  gcd: "gcd",
  Pr: "Pr",
};
const defaults = new Map(Object.entries(operators));
const dictionaries = new WeakMap<object, ReadonlyMap<string, string>>();
function operatorDictionary(custom?: Readonly<Record<string, unknown>>) {
  if (!custom) return defaults;
  const cached = dictionaries.get(custom);
  if (cached) return cached;
  const result = new Map(defaults);
  for (const [name, value] of Object.entries(custom)) {
    result.delete(name);
    if (
      !value ||
      typeof value !== "object" ||
      !("def" in value) ||
      typeof value.def !== "string" ||
      !("args" in value) ||
      value.args !== 0
    )
      continue;
    const command = /^\s*\\operatorname\*\s*/u.exec(value.def);
    const body = command && latexSourceArgument(value.def, command[0].length);
    if (body && !value.def.slice(body.end).trim()) result.set(name, body.value);
  }
  dictionaries.set(custom, result);
  return result;
}

/** Native operators need displaylimits before their scripts in MathLive 0.108. */
export function mathOperatorRenderingInput(
  source: string,
  custom?: Readonly<Record<string, unknown>>,
) {
  if (custom?.operatorname || !source.includes("\\")) return source;
  const dictionary = operatorDictionary(custom);
  const commands = latexSourceCommands(source);
  const used = new Set(commands.map((command) => command.name));
  for (const command of commands.toReversed()) {
    const text = dictionary.get(command.name);
    if (
      !text ||
      [...dictionary].some(
        ([name, body]) => name !== command.name && body === text && used.has(name),
      )
    )
      continue;
    source =
      source.slice(0, command.from) +
      `\\operatorname*{${text}}\\displaylimits` +
      source.slice(command.to);
  }
  return source;
}

/** Convert only our exact screen spelling back to its source command. */
export function mathOperatorRenderingSource(
  source: string,
  custom?: Readonly<Record<string, unknown>>,
  original?: string,
) {
  if (custom?.operatorname || !source.includes("\\displaylimits")) return source;
  const allowed =
    original === undefined
      ? null
      : new Set(latexSourceCommands(original).map((command) => command.name));
  const dictionary = operatorDictionary(custom);
  for (const command of latexSourceCommands(source).toReversed()) {
    if (command.name !== "operatorname" || source[command.to] !== "*") continue;
    const body = latexSourceArgument(source, command.to + 1);
    const limits = body && /^\s*\\displaylimits(?![A-Za-z@])/u.exec(source.slice(body.end));
    const matches = body
      ? [...dictionary].filter(([, text]) => text === body.value).map(([name]) => name)
      : [];
    const name = matches.find((name) => allowed?.has(name)) ?? matches[0];
    if (
      !body ||
      !limits ||
      !name ||
      (allowed &&
        !allowed.has(name) &&
        original?.includes(`\\operatorname*{${body.value}}\\displaylimits`))
    )
      continue;
    source =
      source.slice(0, command.from) + `\\${name}` + source.slice(body.end + limits[0].length);
  }
  return source;
}

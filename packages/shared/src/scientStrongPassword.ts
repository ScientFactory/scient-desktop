import type { DesktopNewPasswordRules as NewPasswordRules } from "@t3tools/contracts";

type CharacterClass = "lower" | "upper" | "digit" | "symbol";

const CLASSES: Readonly<Record<CharacterClass, string>> = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digit: "23456789",
  symbol: "-_!@#$%^&*+=?",
};
/** Long enough that no site's rule about variety matters for its strength. */
const PREFERRED_LENGTH = 20;

/** The limits a page states: lengths, the kinds of character it requires, and any it refuses. */
function readPasswordRules(rules: NewPasswordRules) {
  let min = Math.max(rules.minLength, rules.statedMinLength, 0);
  let max = Math.min(
    ...[rules.maxLength, rules.statedMaxLength].map((limit) =>
      limit > 0 ? limit : Number.POSITIVE_INFINITY,
    ),
  );
  const required = new Set<CharacterClass>(rules.required);
  let symbols: string | undefined = rules.noSymbols ? undefined : CLASSES.symbol;
  // `passwordrules`: "minlength: 8; maxlength: 20; required: upper; allowed: [-_]".
  for (const part of rules.passwordRules.split(";")) {
    const [name, value = ""] = part.split(":").map((item) => item.trim().toLowerCase());
    if (name === "minlength" && Number(value) > 0) min = Math.max(min, Number(value));
    if (name === "maxlength" && Number(value) > 0) max = Math.min(max, Number(value));
    if (name !== "required" && name !== "allowed") continue;
    const kinds = value.split(",").map((item) => item.trim());
    for (const kind of kinds) {
      const set = /^\[(.+)\]$/.exec(kind)?.[1];
      if (set !== undefined) symbols = [...set].filter((char) => !/[a-z0-9]/i.test(char)).join("");
      if (name === "required" && (kind === "lower" || kind === "upper" || kind === "digit"))
        required.add(kind);
      if (name === "required" && (kind === "special" || set !== undefined)) required.add("symbol");
    }
    if (name === "allowed" && !kinds.some((kind) => kind === "special" || kind.startsWith("[")))
      symbols = kinds.includes("ascii-printable") ? symbols : undefined;
  }
  return { min, max, required, symbols };
}

/**
 * A strong password the page's stated rules accept, from `random` (a uniform integer below its
 * argument): 20 characters unless the page asks otherwise, every kind it takes at least once, and
 * its `pattern` matched; a pattern the first shape misses is tried shorter and without symbols.
 * Undefined when the rules can't be met.
 */
export function strongPassword(rules: NewPasswordRules, random: (below: number) => number) {
  const { min, max, required, symbols } = readPasswordRules(rules);
  const length = Math.min(Math.max(PREFERRED_LENGTH, min), max);
  const kinds = (["lower", "upper", "digit", "symbol"] as const).filter(
    (kind) => kind !== "symbol" || symbols,
  );
  if (
    !Number.isFinite(length) ||
    length < kinds.length ||
    [...required].some((kind) => !kinds.includes(kind))
  )
    return undefined;
  const alphabet = (kind: CharacterClass) => (kind === "symbol" ? symbols! : CLASSES[kind]);
  const pick = (characters: string) => characters[random(characters.length)]!;
  let pattern: RegExp | undefined;
  try {
    pattern = rules.pattern ? new RegExp(`^(?:${rules.pattern})$`, "v") : undefined;
  } catch {
    pattern = undefined;
  }
  const shapes = [length, Math.min(length, 16), Math.min(length, 12)].flatMap((size) =>
    size < Math.max(min, kinds.length)
      ? []
      : [
          { size, kinds },
          ...(required.has("symbol")
            ? []
            : [{ size, kinds: kinds.filter((kind) => kind !== "symbol") }]),
        ],
  );
  for (const shape of shapes)
    for (let attempt = 0; attempt < (pattern ? 25 : 1); attempt++) {
      const characters = shape.kinds.map((kind) => pick(alphabet(kind)));
      const all = shape.kinds.map(alphabet).join("");
      while (characters.length < shape.size) characters.push(pick(all));
      for (let index = characters.length - 1; index > 0; index--) {
        const other = random(index + 1);
        [characters[index], characters[other]] = [characters[other]!, characters[index]!];
      }
      const password = characters.join("");
      if (!pattern || pattern.test(password)) return password;
    }
  return undefined;
}

/** A uniform integer below `below` from the platform's secure random source. */
export function secureRandom(below: number) {
  const limit = Math.floor(0x1_0000_0000 / below) * below;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value);
  while (value[0]! >= limit);
  return value[0]! % below;
}

import type { ScientSourceCreator } from "../model.ts";
import { collapseWhitespace, decodeLatex } from "./latex.ts";

function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      separator.lastIndex = index;
      const match = separator.exec(text);
      if (match && match.index === index) {
        parts.push(text.slice(start, index));
        index += match[0].length - 1;
        start = index + 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function startsLowercase(token: string): boolean {
  const letters = token.replace(/^[{\\]+/u, "").replace(/^[^\p{L}]+/u, "");
  return /^\p{Ll}/u.test(letters);
}

function creator(
  creatorType: string,
  givenName: string | null,
  familyName: string | null,
  literalName: string | null = null,
): ScientSourceCreator {
  return { creatorType, givenName, familyName, literalName };
}

function nonEmpty(value: string): string | null {
  const trimmed = collapseWhitespace(value);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parses one BibTeX name ("First von Last", "von Last, First",
 * "von Last, Jr, First"). A name wrapped in one brace group is an
 * institution and stays literal.
 */
function parseBibtexName(raw: string, creatorType: string): ScientSourceCreator | null {
  const name = raw.trim();
  if (!name) return null;
  if (/^\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}$/u.test(name)) {
    const literal = nonEmpty(decodeLatex(name));
    return literal ? creator(creatorType, null, null, literal) : null;
  }
  const commaParts = splitTopLevel(name, /,/uy).map((part) => part.trim());
  const decode = (value: string) => nonEmpty(decodeLatex(value));
  if (commaParts.length >= 2) {
    const familyPart = commaParts[0] ?? "";
    const suffix = commaParts.length >= 3 ? decode(commaParts[1] ?? "") : null;
    const given = decode(commaParts.at(-1) ?? "");
    const family = decode(familyPart);
    if (!family) return given ? creator(creatorType, given, null) : null;
    return creator(creatorType, suffix && given ? `${given}, ${suffix}` : given, family);
  }
  const tokens = splitTopLevel(name, /\s+/uy).filter((token) => token.length > 0);
  if (tokens.length === 1) {
    const family = decode(tokens[0] ?? "");
    return family ? creator(creatorType, null, family) : null;
  }
  // The family name starts at the first lowercase "von" token after the
  // given names, or is the last token when there is none.
  let familyStart = tokens.length - 1;
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (startsLowercase(tokens[index] ?? "")) {
      familyStart = index;
      break;
    }
  }
  return creator(
    creatorType,
    decode(tokens.slice(0, familyStart).join(" ")),
    decode(tokens.slice(familyStart).join(" ")),
  );
}

export function parseBibtexNames(
  value: string,
  creatorType: string,
): { readonly creators: ScientSourceCreator[]; readonly truncated: boolean } {
  let truncated = false;
  const creators = splitTopLevel(value, /\s+and\s+/iuy).flatMap((part) => {
    if (part.trim().toLowerCase() === "others") {
      truncated = true;
      return [];
    }
    return parseBibtexName(part, creatorType) ?? [];
  });
  return { creators, truncated };
}

/**
 * Parses a plain-text personal or corporate name from RIS or EndNote:
 * "Family, Given", "Family, Given, Suffix" or "Given Family". A trailing
 * comma after several words ("World Health Organization,") marks an
 * institution.
 */
export function parsePlainName(raw: string, creatorType: string): ScientSourceCreator | null {
  const name = collapseWhitespace(raw);
  if (!name) return null;
  const parts = name.split(",").map((part) => part.trim());
  if (parts.length >= 2) {
    const family = parts[0] ?? "";
    const given = parts.length >= 3 ? `${parts[1]}, ${parts.slice(2).join(", ")}` : parts[1];
    if (!given) {
      return family.includes(" ")
        ? creator(creatorType, null, null, family)
        : creator(creatorType, null, nonEmpty(family));
    }
    return creator(creatorType, nonEmpty(given), nonEmpty(family));
  }
  const tokens = name.split(" ");
  if (tokens.length === 1) return creator(creatorType, null, name);
  return creator(creatorType, tokens.slice(0, -1).join(" "), tokens.at(-1) ?? null);
}

export function plainCreatorName(value: ScientSourceCreator): string | null {
  if (value.literalName) return value.literalName;
  if (value.familyName && value.givenName) return `${value.familyName}, ${value.givenName}`;
  return value.familyName ?? value.givenName;
}

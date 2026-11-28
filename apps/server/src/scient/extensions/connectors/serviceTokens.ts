// @effect-diagnostics nodeBuiltinImport:off -- Decodes a site's base64 and draws a one-use nonce.
/**
 * Service tokens a site mints from the signed-in session (a mobile-app or embed token, as Moodle
 * and Panopto do): Scient reads the page that hands one out and takes it from the answer by the
 * connector's own recipe. Nothing here knows any site.
 */
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeVM from "node:vm";

export interface TokenRecipe {
  /** An absolute URL on the site; `{nonce}` becomes fresh random hex. */
  readonly url: string;
  /** Its first group is the token, searched in the redirect's address, then the body. */
  readonly pattern: RegExp;
  readonly decode?: "base64" | undefined;
  /** A decoded token made of parts: which one is the token. */
  readonly separator?: string | undefined;
  readonly part?: number | undefined;
}

/** A token is one line of printable text; anything else came from the wrong place. */
const TOKEN = /^[\x21-\x7e]{8,4096}$/u;
/** The recipe's pattern runs over at most this much of a body, or of a redirect's address. */
const MOST_SEARCHED = 1024 * 1024;
const MOST_LOCATION = 8 * 1024;
/** A pattern that backtracks without end is stopped here and finds nothing. */
const MATCH_MS = 100;

/** The pattern's first group in `text`, within the time bound. */
const firstGroup = (pattern: RegExp, text: string) => {
  try {
    const found: unknown = NodeVM.runInNewContext(
      "pattern.exec(text)?.[1]",
      { pattern: new RegExp(pattern.source, pattern.flags), text },
      { timeout: MATCH_MS },
    );
    return typeof found === "string" ? found : undefined;
  } catch {
    return undefined;
  }
};

/** What a minted token depends on in its recipe: an edit to any of it mints anew. */
export const recipeKey = (recipe: TokenRecipe) =>
  [
    recipe.url,
    recipe.pattern.source,
    recipe.decode ?? "",
    recipe.separator ?? "",
    recipe.part ?? 0,
  ].join("\u0000");

/** Fresh for each ask, as the site's own app would make it. */
export const tokenNonce = () => NodeCrypto.randomBytes(16).toString("hex");

export const tokenUrl = (recipe: TokenRecipe, nonce: string) =>
  recipe.url.replaceAll("{nonce}", nonce).replaceAll("%7Bnonce%7D", nonce);

/** The token in the site's answer, or undefined when the answer doesn't hold one. */
export function extractServiceToken(
  recipe: TokenRecipe,
  answer: { readonly location?: string | undefined; readonly body?: string | undefined },
) {
  for (const text of [
    answer.location?.slice(0, MOST_LOCATION),
    answer.body?.slice(0, MOST_SEARCHED),
  ]) {
    const found = text === undefined ? undefined : firstGroup(recipe.pattern, text);
    if (found === undefined) continue;
    const decoded =
      recipe.decode === "base64" ? NodeBuffer.Buffer.from(found, "base64").toString("utf8") : found;
    const token =
      recipe.separator === undefined ? decoded : decoded.split(recipe.separator)[recipe.part ?? 0];
    const trimmed = token?.trim();
    if (trimmed !== undefined && TOKEN.test(trimmed)) return trimmed;
  }
  return undefined;
}

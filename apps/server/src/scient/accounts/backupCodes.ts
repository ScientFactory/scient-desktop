// @effect-diagnostics nodeBuiltinImport:off -- A used code's digest, as kept keys' digests are.
import * as NodeCrypto from "node:crypto";

/** Backup codes as one saved value, one per line (saved with `lines`): a code may hold a space. */
export const backupCodesValue = (codes: ReadonlyArray<string>) => `${codes.join("\n")}\n`;

/** One backup code as sites show them: letters and digits, at most one space or dash inside. */
const CODE_LINE = /^(?=[A-Za-z0-9 -]*\d)[A-Za-z0-9]{3,10}(?:[- ][A-Za-z0-9]{3,10})?$/;

/**
 * The codes in a saved value: one per line when it was saved so (`lines`, or round 1's writes,
 * which ended each code with a line break and carried no flag); otherwise, as backup codes were
 * typed and kept before, split at any space or line break.
 */
export const backupCodeList = (value: string, lines: boolean) => {
  const rows = value.split("\n").map((code) => code.trim());
  const asLines =
    lines || (value.endsWith("\n") && rows.filter(Boolean).every((code) => CODE_LINE.test(code)));
  return (asLines ? rows : value.split(/\s+/).map((code) => code.trim())).filter(Boolean);
};

/** How many used codes each login remembers, newest kept: far more than any site issues at once. */
export const USED_CODES_KEPT = 200;

/** A used code's mark on its login, kept in the encrypted state; spacing and case don't count. */
export const usedCodeDigest = (accountId: string, code: string) =>
  NodeCrypto.createHash("sha256")
    .update(`${accountId}\u0000${code.replace(/[\s-]/g, "").toLowerCase()}`)
    .digest("hex");

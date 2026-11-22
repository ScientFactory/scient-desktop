import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

import { markdownMathRanges } from "~/markdown/wordsHast";

/**
 * The Scient skills a composer message names with `$skill`, as its chips show them: a token
 * inside a formula chat reads stays formula source. Call on the user's composer only, before
 * appending files, captures or history.
 */
export function collectSelectedScientSkillNames(composerText: string): ReadonlyArray<string> {
  return [
    ...new Set(
      collectComposerInlineTokens(`${composerText}\n`, { findMath: markdownMathRanges }).flatMap(
        (token) => (token.type === "skill" && token.value.length <= 64 ? [token.value] : []),
      ),
    ),
  ];
}

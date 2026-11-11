import type { ScientSourceCreator } from "@scientfactory/scient-sources";

/**
 * Splits a display name ("Ada M. Lovelace" or "Lovelace, Ada M.") into given and family
 * names. Registries that give one name string are split at the last space, as Zotero does.
 */
function creatorFromDisplayName(name: string): ScientSourceCreator | null {
  const trimmed = name.replace(/\s+/gu, " ").trim();
  if (!trimmed) return null;
  if (/\b(?:collaboration|consortium|group|team|committee|project)\b/iu.test(trimmed)) {
    return { creatorType: "author", givenName: null, familyName: null, literalName: trimmed };
  }
  const inverted = /^([^,]+),\s*(.+)$/u.exec(trimmed);
  if (inverted?.[1] && inverted[2]) {
    return {
      creatorType: "author",
      givenName: inverted[2],
      familyName: inverted[1],
      literalName: null,
    };
  }
  const lastSpace = trimmed.lastIndexOf(" ");
  return lastSpace > 0
    ? {
        creatorType: "author",
        givenName: trimmed.slice(0, lastSpace),
        familyName: trimmed.slice(lastSpace + 1),
        literalName: null,
      }
    : { creatorType: "author", givenName: null, familyName: null, literalName: trimmed };
}

export function creatorsFromDisplayNames(
  names: ReadonlyArray<string>,
): ReadonlyArray<ScientSourceCreator> {
  return names.flatMap((name) => {
    const creator = creatorFromDisplayName(name);
    return creator ? [creator] : [];
  });
}

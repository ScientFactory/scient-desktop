import type { MenuItemConstructorOptions } from "electron";

import type { LanguageSource, SpellingLanguage } from "./spellingLanguages.ts";

/** Chromium shows at most five suggestions. */
const MAX_SUGGESTIONS = 5;

/** One suggestion from each list in turn, as Chromium mixes languages, without repeats. */
export function interleave(lists: readonly (readonly string[])[]): string[] {
  const result: string[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index++) {
    for (const list of lists) {
      const suggestion = list[index];
      if (suggestion !== undefined && !result.includes(suggestion)) result.push(suggestion);
    }
  }
  return result.slice(0, MAX_SUGGESTIONS);
}

export function suggestionItems(
  suggestions: readonly string[],
  replace: (suggestion: string) => void,
): MenuItemConstructorOptions[] {
  return [
    ...(suggestions.length > 0
      ? suggestions.map((suggestion) => ({ label: suggestion, click: () => replace(suggestion) }))
      : [{ label: "No suggestions", enabled: false }]),
    { type: "separator" },
  ];
}

const SOURCE_NOTE: Readonly<Record<LanguageSource, string>> = {
  system: " (system)",
  alphabet: " (detected)",
  user: "",
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

function languageName(code: string): string {
  try {
    return displayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The languages in use, each with why, and every other dictionary under More Languages. */
export function languagesItem(
  languages: readonly SpellingLanguage[],
  available: readonly string[],
  choose: (code: string, enabled: boolean) => void,
): MenuItemConstructorOptions {
  const inUse = new Set(languages.map(({ code }) => code));
  const others = available
    .filter((code) => !inUse.has(code))
    .map((code) => ({ code, name: languageName(code) }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  return {
    label: "Spelling Languages",
    submenu: [
      ...languages.map(({ code, source }): MenuItemConstructorOptions => ({
        label: `${languageName(code)}${SOURCE_NOTE[source]}`,
        type: "checkbox",
        checked: true,
        click: () => choose(code, false),
      })),
      ...(others.length > 0
        ? [
            ...(languages.length > 0 ? [{ type: "separator" as const }] : []),
            {
              label: "More Languages",
              submenu: others.map(({ code, name }): MenuItemConstructorOptions => ({
                label: name,
                type: "checkbox",
                checked: false,
                click: () => choose(code, true),
              })),
            },
          ]
        : []),
    ],
  };
}

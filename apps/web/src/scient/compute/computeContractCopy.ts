import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/**
 * Contracts and the server describe languages and runtimes in English, because agents read the
 * same words. These tables put them in the app's language where the settings show them, keyed by
 * the contract's own text; anything else (a server failure, an origin a scan named) stays as sent.
 */
const LANGUAGE_GROUP_TITLES: Readonly<Record<string, string>> = {
  "Most used": msg("Most used", { $context: "group of programming languages" }),
  "Statistics and social science": msg("Statistics and social science", {
    $context: "group of programming languages",
  }),
  "Life sciences and medicine": msg("Life sciences and medicine", {
    $context: "group of programming languages",
  }),
  Mathematics: msg("Mathematics", { $context: "group of programming languages" }),
  "Physics and astronomy": msg("Physics and astronomy", {
    $context: "group of programming languages",
  }),
  "Engineering and optimization": msg("Engineering and optimization", {
    $context: "group of programming languages",
  }),
  "Computer science": msg("Computer science", { $context: "group of programming languages" }),
};

/** Whole status lines and the words a runtime line is built from. */
const RUNTIME_WORDS: Readonly<Record<string, string>> = {
  Ready: msg("Ready", { $context: "a programming language's runtime status" }),
  Found: msg("Found", { $context: "a programming language's runtime status" }),
  "Kernel found": msg("Kernel found"),
  "Needs setup": msg("Needs setup"),
  "Not found": msg("Not found", { $context: "a programming language's runtime status" }),
  "Couldn't check": msg("Couldn't check"),
  "Not set up": msg("Not set up"),
  "Set up Scientific Python or choose an existing runtime.": msg(
    "Set up Scientific Python or choose an existing runtime.",
  ),
  "Requires a licensed MATLAB installation on this server.": msg(
    "Requires a licensed MATLAB installation on this server.",
  ),
  "MATLAB connection failed": msg("MATLAB connection failed"),
  "Repair the connection helper.": msg("Repair the connection helper."),
  "Scient-managed runtime needs repair": msg("Scient-managed runtime needs repair"),
  "Scient adds its kernel the first time you run": msg(
    "Scient adds its kernel the first time you run",
  ),
  Automatic: msg("Automatic", { $context: "runtime choice, Scient picks one" }),
  "Scient-managed": msg("Scient-managed", { $context: "where a runtime comes from" }),
  "Custom path": msg("Custom path", { $context: "where a runtime comes from" }),
  "Project environment": msg("Project environment", { $context: "where a runtime comes from" }),
  System: msg("System", { $context: "where a runtime comes from" }),
  "Xcode tools": msg("Xcode tools", { $context: "where a runtime comes from" }),
  "Added location": msg("Added location", { $context: "where a runtime comes from" }),
};

function known(table: Readonly<Record<string, string>>, text: string): string | undefined {
  return Object.hasOwn(table, text) ? table[text] : undefined;
}

/** A language group's title in the app's language. */
export function computeLanguageGroupTitle(title: string, resolve: MessageResolver = m): string {
  const message = known(LANGUAGE_GROUP_TITLES, title);
  return message === undefined ? title : resolve(message);
}

/**
 * A runtime line from the contracts, such as "Not found" or "3.14.6 · System", in the app's
 * language. Versions, paths and origin names it does not know stay as they are.
 */
export function computeRuntimeText(text: string, resolve: MessageResolver = m): string {
  const whole = known(RUNTIME_WORDS, text);
  if (whole !== undefined) return resolve(whole);
  if (!text.includes(" · ")) return text;
  return text
    .split(" · ")
    .map((part) => {
      const message = known(RUNTIME_WORDS, part);
      return message === undefined ? part : resolve(message);
    })
    .join(" · ");
}

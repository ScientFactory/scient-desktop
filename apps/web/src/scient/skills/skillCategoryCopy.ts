import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/**
 * The categories of Scient's built-in skills in the app's language. Each skill's metadata names
 * its category in English, which agents also read; a category this table does not know keeps
 * the metadata's words. The skills' own descriptions stay English.
 */
const CATEGORY_COPY: Readonly<
  Record<string, { readonly title: string; readonly description: string }>
> = {
  "Workspace readiness": {
    title: msg("Workspace readiness", { $context: "category of skills" }),
    description: msg(
      "Review and improve a workspace so people and agents can understand it and work safely.",
    ),
  },
  "Skill creation": {
    title: msg("Skill creation", { $context: "category of skills" }),
    description: msg("Create and improve reusable guidance for Scient agents."),
  },
  "Connector creation": {
    title: msg("Connector creation", { $context: "category of skills" }),
    description: msg("Make and fix connectors that give agents tools for a service."),
  },
  "Document creation": {
    title: msg("Document creation", { $context: "category of skills" }),
    description: msg("Create polished documents and reliable final outputs."),
  },
  Research: {
    title: msg("Research", { $context: "category of skills" }),
    description: msg("Check, find and cite the literature."),
  },
};

/** A skill category's name and description in the app's language. */
export function skillCategoryCopy(
  category: string,
  description: string,
  resolve: MessageResolver = m,
): { readonly title: string; readonly description: string } {
  const copy = Object.hasOwn(CATEGORY_COPY, category) ? CATEGORY_COPY[category] : undefined;
  return copy === undefined
    ? { title: category, description }
    : { title: resolve(copy.title), description: resolve(copy.description) };
}

/** "3 skills". */
export function skillCountLabel(count: number, resolve: MessageResolver = m): string {
  return resolve(msg("{count, plural, one {{count} skill} other {{count} skills}}", { count }));
}

import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/**
 * The Discover categories in the app's language. The server sends their titles and descriptions
 * in English; these tables are keyed by that English, so words they do not know, such as a
 * renamed category, stay as the server sent them.
 */
const CATEGORY_TITLES: Readonly<Record<string, string>> = {
  "Most used": msg("Most used", { $context: "category of connectors and extensions" }),
  "Papers & literature": msg("Papers & literature"),
  "Biology & medicine": msg("Biology & medicine"),
  "Code & developer tools": msg("Code & developer tools"),
  "AI & machine learning": msg("AI & machine learning"),
  "Data & databases": msg("Data & databases"),
  "Cloud, DevOps & security": msg("Cloud, DevOps & security"),
  "Physics, maths & astronomy": msg("Physics, maths & astronomy"),
  "Files & documents": msg("Files & documents"),
  "Email, calendar & chat": msg("Email, calendar & chat"),
  "Projects & tasks": msg("Projects & tasks"),
  "Figures & diagrams": msg("Figures & diagrams"),
  "Chemistry & materials": msg("Chemistry & materials"),
  "Earth & environment": msg("Earth & environment"),
  "Social science, economics & finance": msg("Social science, economics & finance"),
};

const CATEGORY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "What nearly everyone connects, whatever their field.": msg(
    "What nearly everyone connects, whatever their field.",
  ),
  "Find publications, follow citations and weigh the evidence.": msg(
    "Find publications, follow citations and weigh the evidence.",
  ),
  "Genes, proteins, structures, disease, trials and lab data.": msg(
    "Genes, proteins, structures, disease, trials and lab data.",
  ),
  "Repositories, code review, documentation and developer tools.": msg(
    "Repositories, code review, documentation and developer tools.",
  ),
  "Models, datasets, training, evaluation and experiment tracking.": msg(
    "Models, datasets, training, evaluation and experiment tracking.",
  ),
  "Datasets, notebooks, warehouses and databases.": msg(
    "Datasets, notebooks, warehouses and databases.",
  ),
  "Hosting, deployment, monitoring, incidents and security scanning.": msg(
    "Hosting, deployment, monitoring, incidents and security scanning.",
  ),
  "Preprints, symbolic computation, sequences and the sky.": msg(
    "Preprints, symbolic computation, sequences and the sky.",
  ),
  "Your drives, documents and shared workspaces.": msg(
    "Your drives, documents and shared workspaces.",
  ),
  "Mail, meetings, calendars and messages.": msg("Mail, meetings, calendars and messages."),
  "Issues, tasks, boards and project tracking.": msg("Issues, tasks, boards and project tracking."),
  "Scientific illustrations, diagrams, slides and boards.": msg(
    "Scientific illustrations, diagrams, slides and boards.",
  ),
  "Compounds, properties, bioactivity and materials.": msg(
    "Compounds, properties, bioactivity and materials.",
  ),
  "Earth observation, climate, earthquakes, biodiversity and agriculture.": msg(
    "Earth observation, climate, earthquakes, biodiversity and agriculture.",
  ),
  "Economic and development indicators, census data, markets and open studies.": msg(
    "Economic and development indicators, census data, markets and open studies.",
  ),
};

function translated(
  table: Readonly<Record<string, string>>,
  text: string,
  resolve: MessageResolver,
) {
  const message = Object.hasOwn(table, text) ? table[text] : undefined;
  return message === undefined ? text : resolve(message);
}

/** A Discover section's title, translated when Scient knows its words. */
export function extensionCategoryTitle(
  section: { readonly title: string },
  resolve: MessageResolver = m,
): string {
  return translated(CATEGORY_TITLES, section.title, resolve);
}

/** A Discover section's description, translated when Scient knows its words. */
export function extensionCategoryDescription(
  section: { readonly description?: string | undefined },
  resolve: MessageResolver = m,
): string | undefined {
  return section.description === undefined
    ? undefined
    : translated(CATEGORY_DESCRIPTIONS, section.description, resolve);
}

import { describe, expect, it } from "vitest";

import { m, type MessageResolver } from "~/i18n/messages";

import { extensionCategoryDescription, extensionCategoryTitle } from "./extensionCategoryCopy";

/** The section copy a server sent before AI & ML and Cloud: a remote one may still send it. */
const OLDER_SERVER_SECTIONS = [
  ["Most used", "What nearly everyone connects, whatever their field."],
  ["Papers & literature", "Find publications, follow citations and weigh the evidence."],
  ["Biology & medicine", "Genes, proteins, structures, disease, trials and lab data."],
  ["Code & developer tools", "Repositories, models, documentation and deployment."],
  ["Data & databases", "Datasets, notebooks, warehouses and databases."],
  ["Physics, maths & astronomy", "Preprints, symbolic computation, sequences and the sky."],
  ["Files & documents", "Your drives, documents and shared workspaces."],
  ["Email, calendar & chat", "Mail, meetings, calendars and messages."],
  ["Projects & tasks", "Issues, tasks, boards and project tracking."],
  ["Figures & diagrams", "Scientific illustrations, diagrams, slides and boards."],
  ["Chemistry & materials", "Compounds, properties, bioactivity and materials."],
  ["Earth & environment", "Earth observation, climate, earthquakes, biodiversity and agriculture."],
  [
    "Social science & economics",
    "Economic and development indicators, census data and open studies.",
  ],
] as const;

describe("Discover category copy", () => {
  it("translates every section an older server sends", () => {
    const resolve = ((message: string) => `[${m(message)}]`) as MessageResolver;
    for (const [title, description] of OLDER_SERVER_SECTIONS) {
      expect(extensionCategoryTitle({ title }, resolve)).toBe(`[${title}]`);
      expect(extensionCategoryDescription({ description }, resolve)).toBe(`[${description}]`);
    }
    expect(extensionCategoryTitle({ title: "Renamed later" }, resolve)).toBe("Renamed later");
  });
});

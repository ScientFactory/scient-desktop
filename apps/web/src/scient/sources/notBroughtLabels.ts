export {
  notBroughtAmount,
  notBroughtName,
  summarizeNotBrought as notBroughtLines,
} from "@scientfactory/scient-sources";

export const NOT_BROUGHT_LABELS = {
  heading: "Not brought from Zotero",
  about:
    "Zotero holds more for these references than Scient brought. All of it is still in Zotero.",
  show: "Show",
  showAll: "Show all",
  showFewer: "Show fewer",
  shownSources: "References this was not brought for",
} as const;

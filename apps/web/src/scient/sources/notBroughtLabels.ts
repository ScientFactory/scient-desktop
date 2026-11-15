export {
  notBroughtAmount,
  notBroughtBySource,
  notBroughtName,
  summarizeNotBrought as notBroughtLines,
} from "@scientfactory/scient-sources";

export const NOT_BROUGHT_LABELS = {
  heading: "Not brought from Zotero",
  about:
    "Zotero holds more for these references than Scient brought. All of it is still in Zotero. Not looked at: Zotero's Trash, saved searches and tag colours.",
  show: "Show",
  showAll: "Show all",
  showFewer: "Show fewer",
  shownSources: "References this was not brought for",
} as const;

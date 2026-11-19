import { msg } from "gt-react";

export {
  notBroughtAmount,
  notBroughtBySource,
  notBroughtName,
  summarizeNotBrought as notBroughtLines,
} from "@scientfactory/scient-sources";

export const NOT_BROUGHT_LABELS = {
  heading: msg("Not brought from Zotero"),
  about: msg(
    "Zotero holds more for these references than Scient brought. All of it is still in Zotero. Not looked at: Zotero's Trash, saved searches and tag colours.",
  ),
  show: msg("Show", { $context: "verb, shows the references a line names" }),
  showAll: msg("Show all"),
  showFewer: msg("Show fewer"),
  shownSources: msg("References this was not brought for"),
} as const;

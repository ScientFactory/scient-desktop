import { msg, useMessages } from "gt-react";
import { useSyncExternalStore } from "react";

import { DOCUMENT_TEMPLATES, type BuiltInTemplateId } from "./documentTemplates";
import { type TemplatePicture, templatePicture } from "./templatePreviews";
import { userTemplates } from "./userTemplates";

export interface TemplateChoice {
  readonly id: string;
  readonly name: string;
  /** One of the person's own templates, rather than Scient's. */
  readonly own: boolean;
  /** Its first page, shown over its name. */
  readonly picture: TemplatePicture | null;
}

/**
 * The names people see for Scient's templates. `DOCUMENT_TEMPLATES` keeps the English names,
 * because a folder template's new folder is named after it.
 */
const BUILT_IN_TEMPLATE_LABELS = {
  blank: msg("Blank", { $context: "LaTeX document template name" }),
  article: msg("Article", { $context: "LaTeX document template name" }),
  thesis: msg("Thesis", { $context: "LaTeX document template name" }),
  "problem-set": msg("Problem set", { $context: "LaTeX document template name" }),
  "lab-report": msg("Lab report", { $context: "LaTeX document template name" }),
  "lecture-notes": msg("Lecture notes", { $context: "LaTeX document template name" }),
  "grant-proposal": msg("Grant proposal", { $context: "LaTeX document template name" }),
  "response-to-reviewers": msg("Response to reviewers", {
    $context: "LaTeX document template name",
  }),
  letter: msg("Letter", { $context: "LaTeX document template name" }),
  cv: msg("CV", { $context: "LaTeX document template name, curriculum vitae" }),
} satisfies Readonly<Record<BuiltInTemplateId, string>>;

/** Every template a new document can start from: Scient's, then the person's own. */
export function useTemplateChoices(): readonly TemplateChoice[] {
  const messages = useMessages();
  const own = useSyncExternalStore(userTemplates.subscribe, userTemplates.list);
  return [
    ...DOCUMENT_TEMPLATES.map(({ id }) => ({
      id,
      name: messages(BUILT_IN_TEMPLATE_LABELS[id]),
      own: false,
      picture: templatePicture(id, null),
    })),
    ...own.map(({ id, name, preview }) => ({
      id,
      name,
      own: true,
      picture: templatePicture(null, preview),
    })),
  ];
}

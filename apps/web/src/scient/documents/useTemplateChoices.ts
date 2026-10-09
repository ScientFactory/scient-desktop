import { useSyncExternalStore } from "react";

import { DOCUMENT_TEMPLATES } from "./documentTemplates";
import { userTemplates } from "./userTemplates";

export interface TemplateChoice {
  readonly id: string;
  readonly name: string;
  /** One of the person's own templates, rather than Scient's. */
  readonly own: boolean;
}

const builtIns: readonly TemplateChoice[] = DOCUMENT_TEMPLATES.map(({ id, name }) => ({
  id,
  name,
  own: false,
}));

/** Every template a new document can start from: Scient's, then the person's own. */
export function useTemplateChoices(): readonly TemplateChoice[] {
  const own = useSyncExternalStore(userTemplates.subscribe, userTemplates.list);
  return [...builtIns, ...own.map(({ id, name }) => ({ id, name, own: true }))];
}

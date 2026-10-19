import { useMemo, useSyncExternalStore } from "react";

import { DOCUMENT_TEMPLATES } from "./documentTemplates";
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

const builtIns: readonly TemplateChoice[] = DOCUMENT_TEMPLATES.map(({ id, name }) => ({
  id,
  name,
  own: false,
  picture: templatePicture(id, null),
}));

/** Every template a new document can start from: Scient's, then the person's own. */
export function useTemplateChoices(): readonly TemplateChoice[] {
  const own = useSyncExternalStore(userTemplates.subscribe, userTemplates.list);
  return useMemo(
    () => [
      ...builtIns,
      ...own.map(({ id, name, preview }) => ({
        id,
        name,
        own: true,
        picture: templatePicture(null, preview),
      })),
    ],
    [own],
  );
}

import { requestConfirmDialog } from "~/confirmDialog";

import { templateEdits } from "./newDocuments";
import { userTemplates } from "./userTemplates";

/**
 * Deletes one of the person's own templates after asking, from wherever it is
 * offered: the new document's template row or Settings ▸ Documents.
 */
export async function deleteOwnTemplate(id: string, name: string): Promise<void> {
  const confirmed = await requestConfirmDialog(`Delete the template “${name}”?`, {
    variant: "destructive",
  });
  if (confirmed !== true) return;
  await userTemplates.remove(id);
  templateEdits.forgetTemplate(id);
}

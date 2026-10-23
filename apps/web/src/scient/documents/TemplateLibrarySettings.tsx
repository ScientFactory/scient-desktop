import * as Schema from "effect/Schema";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { SettingsRow } from "~/components/settings/settingsLayout";

import {
  DEFAULT_NEW_DOCUMENT_TEMPLATE,
  NEW_DOCUMENT_TEMPLATE_STORAGE_KEY,
  normalizeNewDocumentTemplate,
} from "./documentPreferences";
import {
  moveTemplateToMore,
  moveTemplateToPage,
  hideTemplate,
  reorderTemplates,
  useTemplateLayout,
  type TemplateLayout,
} from "./documentTemplateLayout";
import { deleteOwnTemplate } from "./templateLibrary";
import { TemplateNameDialog } from "./TemplateNameDialog";
import { useTemplateChoices } from "./useTemplateChoices";
import { userTemplates } from "./userTemplates";

type Place = keyof TemplateLayout;

const PLACES: ReadonlyArray<{ readonly id: Place; readonly label: string }> = [
  { id: "page", label: "On the page" },
  { id: "more", label: "More" },
  { id: "hidden", label: "Hidden" },
];

/**
 * Settings ▸ Documents ▸ LaTeX ▸ Templates: the templates a new document
 * offers, in their order, with the default marked. Everything that needs no
 * open document is here, through the same layout and template functions the
 * new document's row uses; making or editing a template stays on a document.
 */
export function TemplatesSettingsRow() {
  const templates = useTemplateChoices();
  const { layout, isDefault, update, restoreDefaults } = useTemplateLayout(
    templates.map((entry) => entry.id),
  );
  const [stored, setDefault] = useLocalStorage(
    NEW_DOCUMENT_TEMPLATE_STORAGE_KEY,
    DEFAULT_NEW_DOCUMENT_TEMPLATE,
    Schema.String,
  );
  const defaultTemplate = normalizeNewDocumentTemplate(stored);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const nameOf = (id: string) => templates.find((entry) => entry.id === id)?.name ?? id;
  const isOwn = (id: string) => templates.some((entry) => entry.id === id && entry.own);

  const move = (place: Place, id: string, step: -1 | 1) => {
    if (place === "hidden") return;
    const over = layout[place][layout[place].indexOf(id) + step];
    if (over !== undefined) update((current) => reorderTemplates(current, place, id, over));
  };

  return (
    <>
      <SettingsRow
        id="new-document-template"
        title="Templates"
        description={`New documents start as ${nameOf(defaultTemplate)}`}
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={open}
            aria-controls="document-template-library"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "Done" : "Manage"}
          </Button>
        }
      />
      {open ? (
        <div id="document-template-library" className="px-3 py-2 sm:px-4">
          {PLACES.filter((place) => layout[place.id].length > 0).map((place) => (
            <section key={place.id} aria-label={place.label} className="py-1.5">
              <h3 className="px-2 pb-1 text-xs text-muted-foreground">{place.label}</h3>
              <ul>
                {layout[place.id].map((id, index, ids) => (
                  <li
                    key={id}
                    data-template-id={id}
                    className="flex min-h-8 items-center gap-2 rounded-md px-2 hover:bg-foreground/[0.035]"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{nameOf(id)}</span>
                    {id === defaultTemplate ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Default</span>
                    ) : null}
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={`${nameOf(id)} actions`}
                          />
                        }
                      >
                        <EllipsisIcon aria-hidden />
                      </MenuTrigger>
                      <MenuPopup align="end" className="min-w-36">
                        <MenuItem disabled={id === defaultTemplate} onClick={() => setDefault(id)}>
                          {id === defaultTemplate ? "Default" : "Set as default"}
                        </MenuItem>
                        {place.id === "hidden" ? (
                          <MenuItem
                            onClick={() => update((current) => moveTemplateToMore(current, id))}
                          >
                            Show
                          </MenuItem>
                        ) : (
                          <>
                            <MenuItem disabled={index === 0} onClick={() => move(place.id, id, -1)}>
                              Move up
                            </MenuItem>
                            <MenuItem
                              disabled={index === ids.length - 1}
                              onClick={() => move(place.id, id, 1)}
                            >
                              Move down
                            </MenuItem>
                            <MenuItem
                              onClick={() =>
                                update((current) =>
                                  place.id === "page"
                                    ? moveTemplateToMore(current, id)
                                    : moveTemplateToPage(current, id),
                                )
                              }
                            >
                              {place.id === "page" ? "Move to More" : "Move to page"}
                            </MenuItem>
                          </>
                        )}
                        {isOwn(id) || place.id !== "hidden" ? <MenuSeparator /> : null}
                        {isOwn(id) ? (
                          <>
                            <MenuItem onClick={() => setRenaming(id)}>Rename…</MenuItem>
                            <MenuItem
                              variant="destructive"
                              onClick={() => void deleteOwnTemplate(id, nameOf(id))}
                            >
                              Delete
                            </MenuItem>
                          </>
                        ) : place.id === "hidden" ? null : (
                          <MenuItem onClick={() => update((current) => hideTemplate(current, id))}>
                            Hide
                          </MenuItem>
                        )}
                      </MenuPopup>
                    </Menu>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {isDefault ? null : (
            <div className="px-2 pt-1.5">
              <Button type="button" size="xs" variant="ghost-muted" onClick={restoreDefaults}>
                Restore defaults
              </Button>
            </div>
          )}
        </div>
      ) : null}
      <TemplateNameDialog
        open={renaming !== null}
        title="Rename template"
        initialName={renaming === null ? "" : nameOf(renaming)}
        actionFor={() => "Rename"}
        onSubmit={async (name) => {
          if (renaming !== null) await userTemplates.rename(renaming, name);
        }}
        onOpenChange={(next) => {
          if (!next) setRenaming(null);
        }}
      />
    </>
  );
}

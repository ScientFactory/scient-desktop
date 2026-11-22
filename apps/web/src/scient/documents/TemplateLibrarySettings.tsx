import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react";
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
  { id: "page", label: msg("On the page") },
  { id: "more", label: msg("More", { $context: "templates under the More menu" }) },
  { id: "hidden", label: msg("Hidden", { $context: "templates not offered" }) },
];

/**
 * Settings ▸ Documents ▸ LaTeX ▸ Templates: the templates a new document
 * offers, in their order, with the default marked. Everything that needs no
 * open document is here, through the same layout and template functions the
 * new document's row uses; making or editing a template stays on a document.
 */
export function TemplatesSettingsRow() {
  const gt = useGT();
  const messages = useMessages();
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
        title={gt("Templates")}
        description={gt("New documents start as {name}", { name: nameOf(defaultTemplate) })}
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={open}
            aria-controls="document-template-library"
            onClick={() => setOpen((current) => !current)}
          >
            {open
              ? gt("Done", { $context: "button, closes template management" })
              : gt("Manage", { $context: "button, opens template management" })}
          </Button>
        }
      />
      {open ? (
        <div id="document-template-library" className="px-3 py-2 sm:px-4">
          {PLACES.filter((place) => layout[place.id].length > 0).map((place) => (
            <section key={place.id} aria-label={messages(place.label)} className="py-1.5">
              <h3 className="px-2 pb-1 text-xs text-muted-foreground">{messages(place.label)}</h3>
              <ul>
                {layout[place.id].map((id, index, ids) => (
                  <li
                    key={id}
                    data-template-id={id}
                    className="flex min-h-8 items-center gap-2 rounded-md px-2 hover:bg-foreground/[0.035]"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{nameOf(id)}</span>
                    {id === defaultTemplate ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <T context="this template is the default">Default</T>
                      </span>
                    ) : null}
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={gt("{name} actions", { name: nameOf(id) })}
                          />
                        }
                      >
                        <EllipsisIcon aria-hidden />
                      </MenuTrigger>
                      <MenuPopup align="end" className="min-w-36">
                        <MenuItem disabled={id === defaultTemplate} onClick={() => setDefault(id)}>
                          {id === defaultTemplate
                            ? gt("Default", { $context: "this template is the default" })
                            : gt("Set as default")}
                        </MenuItem>
                        {place.id === "hidden" ? (
                          <MenuItem
                            onClick={() => update((current) => moveTemplateToMore(current, id))}
                          >
                            <T context="show the hidden template">Show</T>
                          </MenuItem>
                        ) : (
                          <>
                            <MenuItem disabled={index === 0} onClick={() => move(place.id, id, -1)}>
                              <T>Move up</T>
                            </MenuItem>
                            <MenuItem
                              disabled={index === ids.length - 1}
                              onClick={() => move(place.id, id, 1)}
                            >
                              <T>Move down</T>
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
                              {place.id === "page" ? gt("Move to More") : gt("Move to page")}
                            </MenuItem>
                          </>
                        )}
                        {isOwn(id) || place.id !== "hidden" ? <MenuSeparator /> : null}
                        {isOwn(id) ? (
                          <>
                            <MenuItem onClick={() => setRenaming(id)}>
                              <T>Rename…</T>
                            </MenuItem>
                            <MenuItem
                              variant="destructive"
                              onClick={() => void deleteOwnTemplate(id, nameOf(id))}
                            >
                              <T context="delete the template">Delete</T>
                            </MenuItem>
                          </>
                        ) : place.id === "hidden" ? null : (
                          <MenuItem onClick={() => update((current) => hideTemplate(current, id))}>
                            <T context="hide the template">Hide</T>
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
                <T>Restore defaults</T>
              </Button>
            </div>
          )}
        </div>
      ) : null}
      <TemplateNameDialog
        open={renaming !== null}
        title={gt("Rename template")}
        initialName={renaming === null ? "" : nameOf(renaming)}
        actionFor={() => gt("Rename", { $context: "button, renames the template" })}
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

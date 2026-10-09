import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, Ellipsis } from "lucide-react";
import { type MouseEvent, type ReactNode, useContext, useRef, useState } from "react";

import type { ContextMenuItem } from "@t3tools/contracts";
import { requestConfirmDialog } from "~/confirmDialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { readLocalApi } from "~/localApi";

import {
  type TemplateAction,
  applyTemplateAction,
  reorderTemplates,
  templateActions,
  useTemplateLayout,
} from "./documentTemplateLayout";
import { PageZoomContext } from "./NewDocumentOnPage";
import { TemplateCard } from "./TemplateCard";
import type { TemplatePicture } from "./templatePreviews";
import { templateEdits } from "./newDocuments";
import { TemplateNameDialog } from "./TemplateNameDialog";
import type { TemplateChoice } from "./useTemplateChoices";
import { userTemplates } from "./userTemplates";

/**
 * The templates a new document offers: some on its page, in the person's
 * order, the rest behind More. Drag to reorder; right-click a template, or use
 * its ⋯ in More, to make it the default, move it, or hide it.
 */
export function TemplateRow(props: {
  readonly templates: readonly TemplateChoice[];
  readonly selected: string;
  readonly defaultTemplate: string;
  readonly onSelect: (id: string) => void;
  readonly onSetDefault: (id: string) => void;
  /** Opens one of the person's templates on this document, to edit it. */
  readonly onEdit: (id: string) => void;
  /** Makes a template of the person's own, copied from the one chosen. */
  readonly onNewTemplate: (name: string) => Promise<void>;
  /** Marks controls that belong to the new document, so focus there stays with it. */
  readonly strip: Readonly<Record<string, string>>;
  readonly trailing?: ReactNode;
}) {
  const ids = props.templates.map((template) => template.id);
  const { layout, isDefault, update, restoreDefaults } = useTemplateLayout(ids);
  const nameOf = (id: string) => props.templates.find((template) => template.id === id)?.name ?? id;
  const pictureOf = (id: string) =>
    props.templates.find((template) => template.id === id)?.picture ?? null;
  const isOwn = (id: string) =>
    props.templates.some((template) => template.id === id && template.own);
  const [naming, setNaming] = useState<{ readonly rename: string } | "new" | null>(null);
  const chosenInMore = layout.more.includes(props.selected) ? props.selected : null;
  // A drag ends with the pointer released over a template; that is not a choice.
  const justDragged = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const reorder = (list: "page" | "more") => (event: DragEndEvent) => {
    justDragged.current = true;
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
    if (!event.over) return;
    const over = String(event.over.id);
    update((current) => reorderTemplates(current, list, String(event.active.id), over));
  };
  const choose = (id: string) => {
    if (!justDragged.current) props.onSelect(id);
  };

  const openActions = async (id: string, position: { x: number; y: number }) => {
    const items: ContextMenuItem<TemplateAction>[] = [
      ...templateActions(layout, id, props.defaultTemplate, isOwn(id)),
    ];
    const action = await readLocalApi()?.contextMenu.show(items, position);
    if (!action) return;
    if (action === "default") props.onSetDefault(id);
    else if (action === "edit") props.onEdit(id);
    else if (action === "rename") setNaming({ rename: id });
    else if (action === "delete") {
      const confirmed = await requestConfirmDialog(`Delete the template “${nameOf(id)}”?`, {
        variant: "destructive",
      });
      if (confirmed !== true) return;
      await userTemplates.remove(id);
      templateEdits.forgetTemplate(id);
    } else update((current) => applyTemplateAction(current, action, id));
  };
  const contextMenu = (id: string) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void openActions(id, { x: event.clientX, y: event.clientY });
  };

  return (
    <div className="scient-new-document-bar">
      <div role="radiogroup" aria-label="Template">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragEnd={reorder("page")}
        >
          <SortableContext items={[...layout.page]} strategy={horizontalListSortingStrategy}>
            {layout.page.map((id) => (
              <PageTemplate
                key={id}
                id={id}
                name={nameOf(id)}
                picture={pictureOf(id)}
                checked={props.selected === id}
                onChoose={() => choose(id)}
                onContextMenu={contextMenu(id)}
              />
            ))}
          </SortableContext>
        </DndContext>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={chosenInMore !== null}
                onMouseDown={(event) => event.preventDefault()}
              />
            }
          >
            {chosenInMore ? nameOf(chosenInMore) : "More"}
            <ChevronDown aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup
            align="start"
            side="bottom"
            sideOffset={4}
            className="min-w-0"
            data-template-more=""
            {...props.strip}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={reorder("more")}
            >
              <SortableContext items={[...layout.more]} strategy={verticalListSortingStrategy}>
                {layout.more.map((id) => (
                  <MoreTemplate
                    key={id}
                    id={id}
                    name={nameOf(id)}
                    picture={pictureOf(id)}
                    onChoose={() => choose(id)}
                    onContextMenu={contextMenu(id)}
                    onActions={(position) => void openActions(id, position)}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {layout.more.length > 0 ? <MenuSeparator /> : null}
            <MenuItem onClick={() => setNaming("new")}>New template…</MenuItem>
            {isDefault ? null : <MenuItem onClick={restoreDefaults}>Restore defaults</MenuItem>}
          </MenuPopup>
        </Menu>
      </div>
      {props.trailing}
      <TemplateNameDialog
        open={naming !== null}
        title={naming === "new" ? "New template" : "Rename template"}
        initialName={
          naming === null || naming === "new"
            ? `${nameOf(props.selected)} copy`
            : nameOf(naming.rename)
        }
        actionFor={() => (naming === "new" ? "Create" : "Rename")}
        onSubmit={async (name) => {
          if (naming === "new") await props.onNewTemplate(name);
          else if (naming !== null) await userTemplates.rename(naming.rename, name);
        }}
        onOpenChange={(open) => {
          if (!open) setNaming(null);
        }}
      />
    </div>
  );
}

function PageTemplate(props: {
  readonly id: string;
  readonly name: string;
  readonly picture: TemplatePicture | null;
  readonly checked: boolean;
  readonly onChoose: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
}) {
  // Only the pointer drag: the sortable's role and keyboard attributes would
  // replace the element's own (a radio on the page, a menu item in More).
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  // The row is drawn on the zoomed page, and a drag measures the screen.
  const zoom = useContext(PageZoomContext);
  const moved = transform && { ...transform, x: transform.x / zoom, y: transform.y / zoom };
  return (
    <TemplateCard picture={props.picture} side="bottom">
      <button
        ref={setNodeRef}
        type="button"
        {...listeners}
        role="radio"
        aria-checked={props.checked}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(moved), transition }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onChoose}
        onContextMenu={props.onContextMenu}
      >
        {props.name}
      </button>
    </TemplateCard>
  );
}

function MoreTemplate(props: {
  readonly id: string;
  readonly name: string;
  readonly picture: TemplatePicture | null;
  readonly onChoose: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
  readonly onActions: (position: { x: number; y: number }) => void;
}) {
  // Only the pointer drag: the sortable's role and keyboard attributes would
  // replace the element's own (a radio on the page, a menu item in More).
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  const keepToItself = (event: { stopPropagation: () => void; preventDefault: () => void }) => {
    event.stopPropagation();
    event.preventDefault();
  };
  return (
    <TemplateCard picture={props.picture} side="inline-end">
      <MenuItem
        ref={setNodeRef}
        {...listeners}
        data-template-item=""
        aria-label={props.name}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onClick={props.onChoose}
        onContextMenu={props.onContextMenu}
      >
        <span className="min-w-0 flex-1 truncate">{props.name}</span>
        <button
          type="button"
          className="scient-template-actions"
          aria-label={`${props.name} options`}
          onPointerDown={keepToItself}
          onMouseUp={keepToItself}
          onClick={(event) => {
            keepToItself(event);
            const box = event.currentTarget.getBoundingClientRect();
            props.onActions({ x: Math.round(box.right), y: Math.round(box.bottom) });
          }}
        >
          <Ellipsis aria-hidden="true" />
        </button>
      </MenuItem>
    </TemplateCard>
  );
}

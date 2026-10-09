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
import { type MouseEvent, type ReactNode, useContext, useRef } from "react";

import type { ContextMenuItem } from "@t3tools/contracts";
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

export interface TemplateChoice {
  readonly id: string;
  readonly name: string;
}

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
  /** Marks controls that belong to the new document, so focus there stays with it. */
  readonly strip: Readonly<Record<string, string>>;
  readonly trailing?: ReactNode;
}) {
  const ids = props.templates.map((template) => template.id);
  const { layout, isDefault, update, restoreDefaults } = useTemplateLayout(ids);
  const nameOf = (id: string) => props.templates.find((template) => template.id === id)?.name ?? id;
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
    const items: ContextMenuItem<TemplateAction>[] = templateActions(
      layout,
      id,
      props.defaultTemplate,
    ).map((item) => (item.id === "hide" ? { ...item, separatorBefore: true } : item));
    const action = await readLocalApi()?.contextMenu.show(items, position);
    if (!action) return;
    if (action === "default") props.onSetDefault(id);
    else update((current) => applyTemplateAction(current, action, id));
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
                checked={props.selected === id}
                onChoose={() => choose(id)}
                onContextMenu={contextMenu(id)}
              />
            ))}
          </SortableContext>
        </DndContext>
        {layout.more.length > 0 || !isDefault ? (
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
                      onChoose={() => choose(id)}
                      onContextMenu={contextMenu(id)}
                      onActions={(position) => void openActions(id, position)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              {isDefault ? null : (
                <>
                  {layout.more.length > 0 ? <MenuSeparator /> : null}
                  <MenuItem onClick={restoreDefaults}>Restore defaults</MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {props.trailing}
    </div>
  );
}

function PageTemplate(props: {
  readonly id: string;
  readonly name: string;
  readonly checked: boolean;
  readonly onChoose: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  // The row is drawn on the zoomed page, and a drag measures the screen.
  const zoom = useContext(PageZoomContext);
  const moved = transform && { ...transform, x: transform.x / zoom, y: transform.y / zoom };
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
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
  );
}

function MoreTemplate(props: {
  readonly id: string;
  readonly name: string;
  readonly onChoose: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
  readonly onActions: (position: { x: number; y: number }) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  const keepToItself = (event: { stopPropagation: () => void; preventDefault: () => void }) => {
    event.stopPropagation();
    event.preventDefault();
  };
  return (
    <MenuItem
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-template-item=""
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
  );
}

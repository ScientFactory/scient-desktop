import type { ContextMenuItem, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { selectScientSourceMaterial } from "@scientfactory/scient-sources/material-selection";

import { readLocalApi } from "../../localApi";
import { LIBRARY_LABELS } from "./libraryLabels";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type SourceContextAction =
  | "view"
  | "edit"
  | "open-pdf"
  | "select"
  | "remove"
  | "add-to-project"
  | "remove-from-project"
  | "mark-read"
  | "mark-unread";

/** The row menu: which items the session may use, and what each one runs. */
export async function showSourceRowMenu(input: {
  readonly record: SourceRecord;
  readonly anchorPoint: { readonly x: number; readonly y: number };
  readonly listed: NonNullable<ScientSourcesOverviewResult["scopes"]>["listed"] | undefined;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly canChange: boolean;
  readonly canSetReading: boolean;
  readonly canChangeProject: boolean;
  /** False once the panel unmounted or moved to another project while the menu was open. */
  readonly isCurrent: () => boolean;
  readonly onView: () => void;
  readonly onEdit: () => void;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
  readonly onToggleSelected: () => void;
  readonly onSetReadingStatus: (readingStatus: "read" | "unread") => void;
  readonly onAddToProject: () => void;
  readonly onRemoveFromProject: () => void;
  readonly onMoveToTrash: () => void;
}) {
  const { record, listed } = input;
  const api = readLocalApi();
  if (!api) return;
  const materialSelection = selectScientSourceMaterial({ materials: record.attachments });
  const pdf = materialSelection._tag === "Selected" ? materialSelection.material : null;
  type Item = ContextMenuItem<SourceContextAction>;
  const readingItems: Item[] =
    listed && input.canSetReading && record.readingStatus !== undefined
      ? [
          record.readingStatus === "unread"
            ? { id: "mark-read", label: LIBRARY_LABELS.markRead }
            : { id: "mark-unread", label: LIBRARY_LABELS.markUnread },
        ]
      : [];
  const addItems: Item[] =
    listed === "library" && record.pinned === false
      ? [
          {
            id: "add-to-project",
            label: LIBRARY_LABELS.addToProject,
            disabled: input.busy || !input.canChangeProject,
          },
        ]
      : [];
  // In "This project" the source leaves the project and stays in the Library.
  const removeItem: Item =
    listed === "project"
      ? {
          id: "remove-from-project",
          label: LIBRARY_LABELS.removeFromProject,
          disabled: input.busy || !input.canChangeProject,
        }
      : {
          id: "remove",
          label: "Move to Trash",
          destructive: true,
          disabled: input.busy || !input.canChange,
          icon: "trash",
        };
  const items: Item[] = [
    { id: "view", label: "View source details" },
    { id: "edit", label: "Edit source details", icon: "pencil", disabled: !input.canChange },
    ...(pdf ? ([{ id: "open-pdf", label: "Open PDF" }] as const) : []),
    { id: "select", label: input.selected ? "Deselect" : "Select" },
    ...readingItems,
    ...addItems,
    removeItem,
  ];
  const action = await api.contextMenu.show(items, {
    x: input.anchorPoint.x,
    y: input.anchorPoint.y,
  });
  if (!input.isCurrent()) return;
  switch (action) {
    case "view":
      input.onView();
      break;
    case "edit":
      input.onEdit();
      break;
    case "open-pdf":
      if (pdf) {
        input.onOpenPdf({
          sourceId: record.sourceId,
          attachmentId: pdf.attachmentId,
          fileName: pdf.fileName,
        });
      }
      break;
    case "select":
      input.onToggleSelected();
      break;
    case "mark-read":
    case "mark-unread":
      input.onSetReadingStatus(action === "mark-read" ? "read" : "unread");
      break;
    case "add-to-project":
      input.onAddToProject();
      break;
    case "remove-from-project":
      input.onRemoveFromProject();
      break;
    case "remove":
      input.onMoveToTrash();
      break;
    case null:
      break;
  }
}

import { SCIC_FILE_EXTENSION, SCIC_MEDIA_TYPE } from "@t3tools/contracts";

import { dropConversationImportFile } from "./requests";

/**
 * What a file being dragged over Scient may be. Browsers hide file names until
 * the drop, so a drag is judged by its media type: a conversation file when
 * the system reports the `.scic` type, and possibly one when it reports no
 * type, which is what most systems report for `.scic`.
 */
export type ConversationFileDrag = "conversation" | "possible-conversation";

export function conversationFileDrag(
  dataTransfer: Pick<DataTransfer, "types" | "items"> | null,
): ConversationFileDrag | null {
  if (dataTransfer === null || !dataTransfer.types.includes("Files")) return null;
  if (dataTransfer.items.length !== 1) return null;
  const item = dataTransfer.items[0];
  if (item?.kind !== "file") return null;
  if (item.type === SCIC_MEDIA_TYPE) return "conversation";
  return item.type === "" || item.type === "application/octet-stream"
    ? "possible-conversation"
    : null;
}

function isConversationFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(SCIC_FILE_EXTENSION);
}

function isMarkdownFile(file: File): boolean {
  return /\.md$/iu.test(file.name);
}

function singleDroppedFile(event: DragEvent): File | null {
  const files = event.dataTransfer?.files;
  return files?.length === 1 ? (files[0] ?? null) : null;
}

/**
 * Makes one dropped `.scic` anywhere in the window an import, ahead of every
 * other drop target (the chat column and composer attach files, sidebar rows
 * attach to their thread). Handlers run in the capture phase, so such a drag
 * never reaches those targets; any other dropped file keeps its current
 * owner. A single `.md` dropped where nothing else takes it is imported too.
 * `onDragChange` reports the drag so the app can show where it will go.
 */
export function installConversationImportDropTarget(
  target: Window,
  onDragChange: (drag: ConversationFileDrag | null) => void = () => {},
): () => void {
  let depth = 0;
  let current: ConversationFileDrag | null = null;
  const report = (drag: ConversationFileDrag | null) => {
    if (drag === current) return;
    current = drag;
    onDragChange(drag);
  };
  const reset = () => {
    depth = 0;
    report(null);
  };

  const claim = (event: DragEvent) => {
    const drag = conversationFileDrag(event.dataTransfer);
    report(drag);
    if (drag === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onDragEnter = (event: DragEvent) => {
    depth += 1;
    claim(event);
  };
  const onDragLeave = () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) report(null);
  };
  const onCaptureDrop = (event: DragEvent) => {
    reset();
    const file = singleDroppedFile(event);
    if (file === null || !isConversationFile(file)) return;
    event.preventDefault();
    event.stopPropagation();
    dropConversationImportFile(file);
  };

  // Unclaimed areas: let a single file be dropped, and import it if it is Markdown.
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || event.dataTransfer?.types.includes("Files") !== true) return;
    if (event.dataTransfer.items.length !== 1) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented) return;
    const file = singleDroppedFile(event);
    if (file === null || !isMarkdownFile(file)) return;
    event.preventDefault();
    dropConversationImportFile(file);
  };

  const capture = { capture: true } as const;
  target.addEventListener("dragenter", onDragEnter, capture);
  target.addEventListener("dragover", claim, capture);
  target.addEventListener("dragleave", onDragLeave, capture);
  target.addEventListener("drop", onCaptureDrop, capture);
  target.addEventListener("dragend", reset, capture);
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragenter", onDragEnter, capture);
    target.removeEventListener("dragover", claim, capture);
    target.removeEventListener("dragleave", onDragLeave, capture);
    target.removeEventListener("drop", onCaptureDrop, capture);
    target.removeEventListener("dragend", reset, capture);
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}

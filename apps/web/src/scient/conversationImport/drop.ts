import { requestConversationImport } from "./requests";

export function isConversationImportFile(file: File): boolean {
  return /\.(scic|md)$/iu.test(file.name);
}

/** Accepts one import file on the app surface after feature-specific drop targets handle it. */
export function installConversationImportDropTarget(target: Window): () => void {
  const acceptsDrag = (event: DragEvent) =>
    !event.defaultPrevented &&
    event.dataTransfer?.types.includes("Files") === true &&
    (event.dataTransfer.items.length === 1
      ? event.dataTransfer.items[0]?.kind === "file"
      : event.dataTransfer.items.length === 0 && event.dataTransfer.files.length === 1);

  const onDragOver = (event: DragEvent) => {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || event.dataTransfer?.files.length !== 1) return;
    const file = event.dataTransfer.files[0];
    if (!file || !isConversationImportFile(file)) return;
    event.preventDefault();
    requestConversationImport({ _tag: "browser-file", file });
  };

  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}

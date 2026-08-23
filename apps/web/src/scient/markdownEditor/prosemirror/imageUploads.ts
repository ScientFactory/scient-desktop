import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

interface ImageUploadState {
  readonly decorations: DecorationSet;
}

type ImageUploadMeta =
  | {
      readonly action: "add";
      readonly id: string;
      readonly position: number;
      readonly fileName: string;
    }
  | { readonly action: "remove"; readonly id: string };

export const imageUploadPluginKey = new PluginKey<ImageUploadState>("scientMarkdownImageUploads");

function uploadWidget(position: number, id: string, fileName: string): Decoration {
  return Decoration.widget(
    position,
    () => {
      const element = document.createElement("span");
      element.className = "scient-markdown-image-upload";
      element.setAttribute("data-scient-markdown-image-upload", id);
      element.setAttribute("role", "status");
      element.textContent = `Adding ${fileName}…`;
      return element;
    },
    { id, side: 1 },
  );
}

export function imageUploadPlugin(): Plugin<ImageUploadState> {
  return new Plugin<ImageUploadState>({
    key: imageUploadPluginKey,
    state: {
      init: () => ({ decorations: DecorationSet.empty }),
      apply: (transaction, previous) => {
        let decorations = previous.decorations.map(transaction.mapping, transaction.doc);
        const meta: ImageUploadMeta | undefined = transaction.getMeta(imageUploadPluginKey);
        if (meta?.action === "remove") {
          decorations = decorations.remove(
            decorations.find(undefined, undefined, (spec) => spec.id === meta.id),
          );
        } else if (meta?.action === "add") {
          decorations = decorations.add(transaction.doc, [
            uploadWidget(meta.position, meta.id, meta.fileName),
          ]);
        }
        return { decorations };
      },
    },
    props: {
      decorations: (state) => imageUploadPluginKey.getState(state)?.decorations ?? null,
    },
  });
}

export function addImageUploadPlaceholder(
  transaction: Transaction,
  input: { readonly id: string; readonly position: number; readonly fileName: string },
): Transaction {
  return transaction.setMeta(imageUploadPluginKey, {
    action: "add",
    ...input,
  } satisfies ImageUploadMeta);
}

export function removeImageUploadPlaceholder(transaction: Transaction, id: string): Transaction {
  return transaction.setMeta(imageUploadPluginKey, {
    action: "remove",
    id,
  } satisfies ImageUploadMeta);
}

export function imageUploadPlaceholderPosition(state: EditorState, id: string): number | null {
  const decoration = imageUploadPluginKey
    .getState(state)
    ?.decorations.find(undefined, undefined, (spec) => spec.id === id)[0];
  return decoration?.from ?? null;
}

import { Plugin, PluginKey, type Selection, type Transaction } from "@tiptap/pm/state";

type Bookmark = ReturnType<Selection["getBookmark"]>;
type PendingImages = ReadonlyMap<string, Bookmark>;

type ImageUploadMeta =
  | { readonly action: "add"; readonly id: string; readonly bookmark: Bookmark }
  | { readonly action: "remove"; readonly id: string };

const key = new PluginKey<PendingImages>("scientLatexImageUploads");

export function latexImageUploads() {
  return new Plugin<PendingImages>({
    key,
    state: {
      init: () => new Map(),
      apply: (transaction, previous) => {
        const next = new Map<string, Bookmark>();
        for (const [id, bookmark] of previous) next.set(id, bookmark.map(transaction.mapping));
        const meta: ImageUploadMeta | undefined = transaction.getMeta(key);
        if (meta?.action === "add") next.set(meta.id, meta.bookmark);
        if (meta?.action === "remove") next.delete(meta.id);
        return next;
      },
    },
  });
}

export function addLatexImageUpload(
  transaction: Transaction,
  id: string,
  bookmark: Bookmark,
): Transaction {
  return transaction.setMeta(key, { action: "add", id, bookmark } satisfies ImageUploadMeta);
}

export function removeLatexImageUpload(transaction: Transaction, id: string): Transaction {
  return transaction.setMeta(key, { action: "remove", id } satisfies ImageUploadMeta);
}

export function latexImageUploadBookmark(state: Parameters<typeof key.getState>[0], id: string) {
  return key.getState(state)?.get(id) ?? null;
}

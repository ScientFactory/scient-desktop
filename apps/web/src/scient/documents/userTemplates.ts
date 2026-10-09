import { randomUUID } from "~/lib/utils";

/**
 * The person's own LaTeX templates, kept on this device in every project:
 * a main source with its title left empty, the files it includes, and a
 * picture of its first page. Held in memory once read; other windows hear of
 * each change.
 */
export interface UserTemplate {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  /** Files the main source includes, relative to its folder. */
  readonly files: Readonly<Record<string, string>>;
  /** The first page as the Visual editor drew it, or null. */
  readonly preview: string | null;
  readonly updatedAt: number;
}

export const USER_TEMPLATE_PREFIX = "user:";
const DATABASE = "scient-document-templates";
const STORE = "templates";
const CHANNEL = "scient-document-templates";

let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: "id" });
    });
    request.addEventListener("success", () => {
      request.result.addEventListener("versionchange", () => request.result.close());
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
    request.addEventListener("blocked", () => {
      database = undefined;
      reject(new Error("Close older Scient windows and reload to use your templates."));
    });
  }));
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return db().then(
    (open) =>
      new Promise<T>((resolve, reject) => {
        const transaction = open.transaction(STORE, mode);
        const request = work(transaction.objectStore(STORE));
        transaction.addEventListener("complete", () => resolve(request.result));
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      }),
  );
}

let templates: readonly UserTemplate[] = [];
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function settle(next: readonly UserTemplate[]) {
  templates = next.toSorted((a, b) => a.name.localeCompare(b.name));
  notify();
}

function reload(): Promise<void> {
  loading = run("readonly", (store) => store.getAll() as IDBRequest<UserTemplate[]>).then(
    settle,
    (error: unknown) => {
      console.error("Your templates could not be read:", error);
    },
  );
  return loading;
}

/** Other windows read the templates again. */
function tellOtherWindows() {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not Window.postMessage.
  channel?.postMessage("changed");
}

export const userTemplates = {
  /** Reads the templates once; later calls wait for the same read. */
  ready(): Promise<void> {
    if (loading) return loading;
    if (typeof BroadcastChannel !== "undefined" && channel === null) {
      channel = new BroadcastChannel(CHANNEL);
      channel.addEventListener("message", () => void reload());
    }
    return reload();
  },
  list(): readonly UserTemplate[] {
    return templates;
  },
  get(id: string): UserTemplate | null {
    return templates.find((template) => template.id === id) ?? null;
  },
  async save(
    template: Omit<UserTemplate, "id" | "updatedAt"> & { readonly id?: string },
  ): Promise<UserTemplate> {
    const saved: UserTemplate = {
      ...template,
      id: template.id ?? `${USER_TEMPLATE_PREFIX}${randomUUID()}`,
      updatedAt: Date.now(),
    };
    await run("readwrite", (store) => store.put(saved));
    settle([...templates.filter((entry) => entry.id !== saved.id), saved]);
    tellOtherWindows();
    return saved;
  },
  async rename(id: string, name: string): Promise<void> {
    const current = this.get(id);
    if (!current) return;
    await this.save({ ...current, name });
  },
  async remove(id: string): Promise<void> {
    await run("readwrite", (store) => store.delete(id));
    settle(templates.filter((entry) => entry.id !== id));
    tellOtherWindows();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    void userTemplates.ready();
    return () => listeners.delete(listener);
  },
};

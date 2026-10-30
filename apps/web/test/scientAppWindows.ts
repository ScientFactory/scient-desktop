import { vi } from "vite-plus/test";

/** Replaces globals until disposed, then restores exactly what was there. */
export function stubGlobals(values: Readonly<Record<string, unknown>>): Disposable {
  const stack = new DisposableStack();
  for (const [name, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    stack.defer(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return stack;
}

/** One localStorage that the app windows of a test share. */
export function sharedLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => void values.set(key, value),
    removeItem: (key: string): void => void values.delete(key),
  };
}

export type SharedLocalStorage = ReturnType<typeof sharedLocalStorage>;

/**
 * Fresh copies of the modules `load` imports, as one more app window on `storage` sees them.
 * The window's globals stay in place until it is disposed.
 */
export async function openAppWindow<M>(storage: SharedLocalStorage, load: () => Promise<M>) {
  const appWindow = Object.assign(new EventTarget(), { localStorage: storage });
  const globals = stubGlobals({ localStorage: storage, window: appWindow });
  try {
    vi.resetModules();
    const module = await load();
    return {
      module,
      /** Another window wrote `key`. */
      receiveStorageEvent: (key: string) =>
        appWindow.dispatchEvent(Object.assign(new Event("storage"), { key })),
      unload: () => appWindow.dispatchEvent(new Event("beforeunload")),
      [Symbol.dispose]: () => globals[Symbol.dispose](),
    };
  } catch (error) {
    globals[Symbol.dispose]();
    throw error;
  }
}

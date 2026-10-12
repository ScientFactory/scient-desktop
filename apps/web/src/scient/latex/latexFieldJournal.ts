/** A field may replace or retire only the exact recovery record it observed. */
export function createLatexFieldJournal() {
  const owned = new Map<string, string | null>();
  const slot = (key: string) => `scient.latex.field:${key}`;
  const failed = (key: string) => {
    window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
    return false;
  };
  return {
    observe(key: string | undefined, base: string) {
      if (!key || owned.has(key)) return;
      try {
        const stored = localStorage.getItem(slot(key));
        const entry: unknown = stored === null ? null : JSON.parse(stored);
        owned.set(
          key,
          entry && typeof entry === "object" && "base" in entry && entry.base === base
            ? stored
            : null,
        );
      } catch {
        failed(key);
      }
    },
    write(key: string | undefined, base: string, text: string) {
      if (!key) return true;
      try {
        const current = localStorage.getItem(slot(key));
        const next = JSON.stringify({ base, text });
        if (current !== null && current !== owned.get(key) && current !== next) return failed(key);
        localStorage.setItem(slot(key), next);
        owned.set(key, next);
        return true;
      } catch {
        return failed(key);
      }
    },
    clear(key: string | undefined) {
      if (!key) return true;
      try {
        const current = localStorage.getItem(slot(key));
        if (current !== null && current !== owned.get(key)) return false;
        localStorage.removeItem(slot(key));
        owned.set(key, null);
        return true;
      } catch {
        return failed(key);
      }
    },
  };
}

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronUp } from "lucide-react";
import "mathlive/static.css";
import { MATH_SYMBOL_CATEGORIES, MATH_SYMBOLS, type MathSymbol } from "./mathSymbols";
import { mathSymbolPreview } from "./mathSymbolPresentation";
import type { LatexMathFieldHandle } from "./LatexMathField";

const STORAGE_KEY = "scient.latex.math-palette.v1";
const byId = new Map(MATH_SYMBOLS.map((symbol) => [symbol.id, symbol]));

function readPreferences(
  fallback: { recent: string[]; favorites: string[] } = { recent: [], favorites: [] },
): { recent: string[]; favorites: string[] } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const read = (key: string) => {
      const entries = value && typeof value === "object" ? Reflect.get(value, key) : undefined;
      return Array.isArray(entries)
        ? entries.filter((id): id is string => typeof id === "string" && byId.has(id)).slice(0, 32)
        : [];
    };
    return { recent: read("recent"), favorites: read("favorites") };
  } catch {
    return fallback;
  }
}

function SymbolGlyph({ symbol }: { symbol: MathSymbol }) {
  const preview = mathSymbolPreview(symbol);
  return preview.markup ? (
    <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: preview.markup }} />
  ) : (
    <span aria-hidden="true" className="scient-latex-symbol-palette-command">
      {symbol.glyph ?? symbol.command}
    </span>
  );
}

export function LatexMathPalette({
  onInsert,
  onCommand,
  onReturnToMath,
  sourceOpen,
  onOpen,
}: {
  onInsert: (symbol: MathSymbol) => void;
  onCommand: LatexMathFieldHandle["command"];
  onReturnToMath: () => void;
  sourceOpen: boolean;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("latex_greek");
  const [query, setQuery] = useState("");
  const [preferences, setPreferences] = useState(readPreferences);
  const [activeId, setActiveId] = useState<string | null>(null);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sourceOpen) setOpen(false);
  }, [sourceOpen]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!event.composedPath().includes(root.current!)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  const symbols = useMemo(() => {
    if (query.trim()) {
      const terms = query.toLowerCase().trim().replace(/^\\/u, "").split(/\s+/u);
      return MATH_SYMBOLS.filter((symbol) => terms.every((term) => symbol.search.includes(term)));
    }
    if (category === "recent" || category === "favorites")
      return preferences[category].map((id) => byId.get(id)!).filter(Boolean);
    return MATH_SYMBOLS.filter((symbol) => symbol.category === category);
  }, [category, preferences, query]);
  const active = symbols.find((symbol) => symbol.id === activeId) ?? symbols[0];
  const activePreview = active ? mathSymbolPreview(active) : null;
  const remember = (next: typeof preferences) => {
    setPreferences(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* Session state still works. */
    }
  };
  const insert = (symbol: MathSymbol) => {
    const latest = readPreferences(preferences);
    remember({
      ...latest,
      recent: [symbol.id, ...latest.recent.filter((id) => id !== symbol.id)].slice(0, 24),
    });
    onInsert(symbol);
    setOpen(false);
  };
  const show = (nextCategory: string) => {
    onOpen();
    setPreferences(readPreferences(preferences));
    setCategory(nextCategory);
    setQuery("");
    setActiveId(null);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    onReturnToMath();
  };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const buttons = [
      ...(grid.current?.querySelectorAll<HTMLButtonElement>("button[data-symbol]") ?? []),
    ];
    const columns = buttons.length
      ? buttons.filter((button) => button.offsetTop === buttons[0]!.offsetTop).length
      : 1;
    const next =
      event.key === "ArrowRight"
        ? index + 1
        : event.key === "ArrowLeft"
          ? index - 1
          : event.key === "ArrowDown"
            ? index + columns
            : event.key === "ArrowUp"
              ? index - columns
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : null;
    if (next !== null) {
      event.preventDefault();
      buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
    }
  };
  return (
    <div ref={root} className="scient-latex-symbol-palette">
      <button
        type="button"
        className="scient-latex-symbol-palette-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? close() : show(category))}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            show(category);
            requestAnimationFrame(() => search.current?.focus());
          }
        }}
      >
        Symbols <ChevronUp aria-hidden="true" />
      </button>
      {open && (
        <section
          id={panelId}
          className="scient-latex-symbol-palette-panel"
          aria-label="Math symbol palette"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          <div className="scient-latex-symbol-palette-header">
            <input
              ref={search}
              type="search"
              placeholder="Search symbols or LaTeX commands…"
              aria-label="Search math symbols"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  grid.current?.querySelector<HTMLButtonElement>("button[data-symbol]")?.focus();
                }
                if (event.key === "Enter" && active) {
                  event.preventDefault();
                  insert(active);
                }
              }}
            />
            <button
              type="button"
              aria-label="Close symbol palette"
              title="Close (Escape)"
              onClick={close}
            >
              ×
            </button>
          </div>
          <div className="scient-latex-symbol-palette-body">
            <nav
              className="scient-latex-symbol-palette-categories"
              aria-label="Math symbol categories"
            >
              {[
                ["recent", "Recent", "◷"],
                ["favorites", "Favorites", "☆"],
                ...MATH_SYMBOL_CATEGORIES,
              ].map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={!query && category === id}
                  onClick={() => {
                    setCategory(id!);
                    setQuery("");
                    setActiveId(null);
                  }}
                >
                  <span aria-hidden="true">{icon}</span>
                  {label}
                </button>
              ))}
            </nav>
            <div className="scient-latex-symbol-palette-results">
              <div className="scient-latex-symbol-palette-count">
                {query
                  ? "Search results"
                  : category === "recent"
                    ? "Recently used"
                    : category === "favorites"
                      ? "Favorites"
                      : MATH_SYMBOL_CATEGORIES.find(([id]) => id === category)?.[1]}{" "}
                <span>{symbols.length}</span>
              </div>
              <div
                ref={grid}
                className="scient-latex-symbol-palette-grid"
                key={`${category}:${query}`}
              >
                {symbols.map((symbol, index) => (
                  <button
                    key={symbol.id}
                    type="button"
                    data-symbol=""
                    aria-label={`${symbol.label}, ${symbol.command}`}
                    title={`${symbol.label}\n${symbol.command}`}
                    tabIndex={active?.id === symbol.id ? 0 : -1}
                    data-active={active?.id === symbol.id || undefined}
                    onMouseEnter={() => setActiveId(symbol.id)}
                    onFocus={() => setActiveId(symbol.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    onKeyDown={(event) => navigate(event, index)}
                    onClick={() => insert(symbol)}
                  >
                    <SymbolGlyph symbol={symbol} />
                  </button>
                ))}
              </div>
              {category === "structures" && !query && (
                <div
                  className="scient-latex-symbol-palette-matrix-tools"
                  aria-label="Edit current matrix"
                >
                  <span>At the matrix cursor</span>
                  {(
                    [
                      ["addRowAfter", "+ Row"],
                      ["addColumnAfter", "+ Column"],
                      ["removeRow", "− Row"],
                      ["removeColumn", "− Column"],
                    ] as const
                  ).map(([command, label]) => (
                    <button
                      key={command}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        onCommand(command);
                        setOpen(false);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {!symbols.length && (
                <p className="scient-latex-symbol-palette-empty">
                  {query
                    ? "No matching symbols. Try a name or a command such as alpha."
                    : category === "favorites"
                      ? "Choose a symbol, then use the star below to keep it here."
                      : "Symbols you insert will appear here."}
                </p>
              )}
            </div>
          </div>
          <div className="scient-latex-symbol-palette-detail">
            <div>
              <strong>{active?.label ?? "Math symbols"}</strong>
              <code>{active?.command ?? ""}</code>
              <small>
                {activePreview?.sourceOnly
                  ? "LaTeX command · glyph appears in the compiled PDF"
                  : active?.packages.length
                    ? `Uses ${active.packages.join(", ")}`
                    : "Click to insert · arrow keys to browse"}
              </small>
            </div>
            {active && (
              <button
                type="button"
                aria-label={
                  preferences.favorites.includes(active.id) ? "Remove favorite" : "Add favorite"
                }
                aria-pressed={preferences.favorites.includes(active.id)}
                onClick={() =>
                  remember({
                    ...preferences,
                    favorites: preferences.favorites.includes(active.id)
                      ? preferences.favorites.filter((id) => id !== active.id)
                      : [active.id, ...preferences.favorites].slice(0, 32),
                  })
                }
              >
                {preferences.favorites.includes(active.id) ? "★" : "☆"}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

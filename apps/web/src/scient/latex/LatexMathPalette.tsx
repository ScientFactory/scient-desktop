import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { ChevronUp } from "lucide-react";
import "mathlive/static.css";
import { MATH_SYMBOL_CATEGORIES, MATH_SYMBOLS, type MathSymbol } from "./mathSymbols";
import { mathSymbolPreview } from "./mathSymbolPresentation";
import { getKeyboardPreferences, subscribeKeyboardPreferences } from "../keyboard/preferences";
import { mathSymbolShortcuts } from "./mathSymbolShortcuts";

const STORAGE_KEY = "scient.latex.math-palette.v1";
const byId = new Map(MATH_SYMBOLS.map((symbol) => [symbol.id, symbol]));
const PALETTE_GROUPS = [
  {
    id: "common",
    label: "Common",
    icon: "√",
    categories: ["structures", "frac-square", "sqrt-square", "annotations"],
  },
  { id: "annotations", label: "Braces & annotations", icon: "⏟", categories: ["annotations"] },
  { id: "greek", label: "Greek letters", icon: "α", categories: ["latex_greek"] },
  {
    id: "operators",
    label: "Operators & relations",
    icon: "≤",
    categories: ["latex_bop", "latex_brel", "latex_ams_ops", "latex_ams_rel", "latex_ams_nrel"],
  },
  { id: "arrows", label: "Arrows", icon: "→", categories: ["latex_arrow", "latex_ams_arrows"] },
  { id: "large", label: "Sums, integrals & limits", icon: "∑", categories: ["latex_varsz"] },
  {
    id: "brackets",
    label: "Brackets & accents",
    icon: "[ ]",
    categories: ["latex_delim", "latex_deco"],
  },
  {
    id: "functions",
    label: "Functions & math alphabets",
    icon: "ℝ",
    categories: ["functions", "font"],
  },
  {
    id: "other",
    label: "More symbols",
    icon: "…",
    categories: MATH_SYMBOL_CATEGORIES.map(([id]) => id).filter((id) =>
      ["latex_dots", "space", "style", "latex_misc", "latex_ams_misc"].includes(id),
    ),
  },
];

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
  onReturnToMath,
  sourceOpen,
  onOpen,
  openRequest = 0,
  picker = false,
  onDismiss,
}: {
  onInsert: (symbol: MathSymbol) => void;
  onReturnToMath: () => void;
  sourceOpen: boolean;
  onOpen: () => void;
  openRequest?: number;
  picker?: boolean;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(picker);
  const [category, setCategory] = useState("common");
  const [query, setQuery] = useState("");
  const [preferences, setPreferences] = useState(readPreferences);
  const [activeId, setActiveId] = useState<string | null>(null);
  const keyboard = useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const shortcuts = useMemo(
    () =>
      new Map(
        MATH_SYMBOLS.map((symbol) => [
          symbol.id,
          mathSymbolShortcuts(symbol, keyboard.preferences).join(" · "),
        ]),
      ),
    [keyboard],
  );
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openRequest) setOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (sourceOpen) setOpen(false);
  }, [sourceOpen]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!event.composedPath().includes(root.current!)) {
        setOpen(false);
        onDismiss?.();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, onDismiss]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const symbols = useMemo(() => {
    if (query.trim()) {
      const terms = query.toLowerCase().trim().replace(/^\\/u, "").split(/\s+/u);
      return MATH_SYMBOLS.filter((symbol) => terms.every((term) => symbol.search.includes(term)));
    }
    if (category === "recent" || category === "favorites")
      return preferences[category].map((id) => byId.get(id)!).filter(Boolean);
    return MATH_SYMBOLS.filter((symbol) =>
      PALETTE_GROUPS.find((group) => group.id === category)?.categories.includes(symbol.category),
    );
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
    <div ref={root} className="scient-latex-symbol-palette" data-dock-command-scope="latex">
      {!picker && (
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
          Symbols & structures <ChevronUp aria-hidden="true" />
        </button>
      )}
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
            <button type="button" aria-label="Close symbol palette" onClick={close}>
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
                ...PALETTE_GROUPS.map(({ id, label, icon }) => [id, label, icon]),
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
                      : PALETTE_GROUPS.find(({ id }) => id === category)?.label}{" "}
                <span>{symbols.length}</span>
              </div>
              <div
                ref={grid}
                className="scient-latex-symbol-palette-grid"
                key={`${category}:${query}`}
              >
                {symbols.map((symbol, index) => (
                  <ScientTooltip
                    key={symbol.id}
                    content={`${symbol.label} (${symbol.command})${shortcuts.get(symbol.id) ? ` · ${shortcuts.get(symbol.id)}` : ""}`}
                  >
                    <button
                      type="button"
                      data-symbol=""
                      aria-label={`${symbol.label}, ${symbol.command}${shortcuts.get(symbol.id) ? `, ${shortcuts.get(symbol.id)}` : ""}`}
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
                  </ScientTooltip>
                ))}
              </div>
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
              {active && shortcuts.get(active.id) && (
                <small>Shortcut: {shortcuts.get(active.id)}</small>
              )}
              {active?.latex.includes("#?") && (
                <small>Tab moves between the expression and label slots.</small>
              )}
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

import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import {
  memo,
  useEffect,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  Baseline,
  Blend,
  Braces,
  ChevronUp,
  Clock,
  Ellipsis,
  Equal,
  FileBraces,
  Omega,
  Parentheses,
  Plus,
  Radical,
  Search,
  Shapes,
  Sigma,
  SquareFunction,
  Space,
  Star,
  Type,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Kbd } from "~/components/ui/kbd";
import { dockButtonClass } from "../writing/dockChrome";
import "mathlive/static.css";
import "./latexMathPalette.css";
import { MATH_SYMBOLS, mathSymbolCommand, type MathSymbol } from "./mathSymbols";
import {
  MATH_PALETTE_GROUPS,
  mathPaletteGroup,
  mathPaletteSymbols,
  searchMathPalette,
} from "./mathSymbolPalette";
import { mathSymbolPreview } from "./mathSymbolPresentation";
import { MathSymbolIllustration } from "./MathSymbolIllustration";
import { MathSymbolOutline } from "./MathSymbolOutline";
import {
  effectiveSurfaceBindings,
  getKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "../keyboard/preferences";
import { isMacKeyboard } from "../keyboard/keys";
import { mathSymbolShortcuts } from "./mathSymbolShortcuts";
import { LatexAuthoringContext } from "./latexObjectAuthoring";
import { latexDocumentMathSetup } from "./latexDocumentMacros";
import { latexPackageInventory } from "./latexPackages";

const STORAGE_KEY = "scient.latex.math-palette.v1";
const byId = new Map(MATH_SYMBOLS.map((symbol) => [symbol.id, symbol]));
const paletteCategories = [
  { id: "recent", label: "Recent", Icon: Clock },
  { id: "favorites", label: "Favorites", Icon: Star },
  { id: "document", label: "Macros", Icon: FileBraces },
  ...MATH_PALETTE_GROUPS.map((group) => ({
    ...group,
    Icon: {
      common: Shapes,
      structures: Radical,
      annotations: Braces,
      greek: Omega,
      operators: Plus,
      sets: Blend,
      relations: Equal,
      arrows: ArrowLeftRight,
      large: Sigma,
      accents: Baseline,
      brackets: Parentheses,
      functions: SquareFunction,
      alphabets: Type,
      spacing: Space,
      other: Ellipsis,
    }[group.id],
  })),
];

function readPreferences(
  fallback: { recent: string[]; favorites: string[] } = { recent: [], favorites: [] },
): { recent: string[]; favorites: string[] } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const read = (key: string) => {
      const entries = value && typeof value === "object" ? Reflect.get(value, key) : undefined;
      return Array.isArray(entries)
        ? entries
            .filter(
              (id): id is string =>
                typeof id === "string" && (byId.has(id) || /^document:[A-Za-z]+$/u.test(id)),
            )
            .slice(0, 32)
        : [];
    };
    return { recent: read("recent"), favorites: read("favorites") };
  } catch {
    return fallback;
  }
}

const SymbolGlyph = memo(function SymbolGlyph({ symbol }: { symbol: MathSymbol }) {
  const glyph = useRef<HTMLSpanElement>(null);
  const preview = mathSymbolPreview(symbol);
  useLayoutEffect(() => {
    const element = glyph.current;
    const tile = element?.closest("button");
    if (!element || !tile) return;
    let mounted = true;
    const fit = () => {
      if (!mounted) return;
      const style = getComputedStyle(tile);
      const width =
        tile.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height =
        tile.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const scale = Math.min(
        1,
        width / Math.max(1, element.scrollWidth),
        height / Math.max(1, element.scrollHeight),
      );
      element.style.transform = `scale(${scale})`;
    };
    fit();
    void element.ownerDocument.fonts?.ready.then(fit);
    return () => {
      mounted = false;
    };
  });
  return (
    <span ref={glyph} className="scient-latex-symbol-palette-glyph" aria-hidden="true">
      {preview.outline ? (
        <MathSymbolOutline outline={preview.outline} />
      ) : preview.markup ? (
        <span dangerouslySetInnerHTML={{ __html: preview.markup }} />
      ) : preview.illustration ? (
        <MathSymbolIllustration illustration={preview.illustration} />
      ) : symbol.glyph ? (
        <span>{symbol.glyph}</span>
      ) : (
        <FileBraces className="scient-latex-symbol-illustration" />
      )}
    </span>
  );
});

function SymbolCommand({
  symbol,
  shortcuts,
}: {
  symbol: MathSymbol;
  shortcuts: readonly string[];
}) {
  return (
    <div className="scient-latex-symbol-command-detail">
      <code dir="ltr">{mathSymbolCommand(symbol)}</code>
      {shortcuts.length > 0 && (
        <div className="scient-latex-symbol-palette-shortcuts" aria-label="Shortcuts">
          {shortcuts.map((shortcut) => (
            <Kbd key={shortcut}>{shortcut}</Kbd>
          ))}
        </div>
      )}
    </div>
  );
}

export function LatexMathPalette({
  onInsert,
  onReturnToMath,
  sourceOpen,
  onOpen,
  openRequest = 0,
  onOpenRequestHandled,
  picker = false,
  showTrigger = true,
  onDismiss,
}: {
  onInsert: (symbol: MathSymbol) => void;
  onReturnToMath: () => void;
  sourceOpen: boolean;
  onOpen: () => void;
  openRequest?: number;
  onOpenRequestHandled?: (request: number) => void;
  picker?: boolean;
  showTrigger?: boolean;
  onDismiss?: () => void;
}) {
  const documentSetup = useContext(LatexAuthoringContext);
  const preamble = latexPackageInventory(documentSetup.source).preamble;
  const catalog = useMemo(
    () =>
      mathPaletteSymbols([
        ...MATH_SYMBOLS,
        ...Object.entries(latexDocumentMathSetup(preamble).macros).map(
          ([name, macro]): MathSymbol => ({
            id: `document:${name}`,
            category: "document",
            label: `\\${name}`,
            command: `\\${name}`,
            latex: `\\${name}${Array.from({ length: macro.args }, (_, index) => `{${index === 0 ? "#0" : ""}}`).join("")}`,
            preview: macro.def.replace(/#[1-9]/gu, "x"),
            packages: [],
            search: `document macro ${name.toLowerCase()}`,
          }),
        ),
      ]),
    [preamble],
  );
  const paletteById = useMemo(
    () => new Map(catalog.map((symbol) => [symbol.id, symbol])),
    [catalog],
  );
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
  const shortcuts = useMemo(() => {
    const bindings = effectiveSurfaceBindings(keyboard.preferences, isMacKeyboard());
    return new Map(
      MATH_SYMBOLS.map((symbol) => [symbol.id, mathSymbolShortcuts(symbol, bindings)]),
    );
  }, [keyboard]);
  const panelId = useId();
  const ownerId = useId();
  const panelRoot = useRef<HTMLElement>(null);
  const [portalHost, setPortalHost] = useState<Element | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setPortalHost(root.current?.closest(".scient-latex-reader-footer") ?? null);
  }, []);
  useEffect(() => {
    if (!openRequest) return;
    setOpen(true);
    onOpenRequestHandled?.(openRequest);
  }, [openRequest, onOpenRequestHandled]);
  useEffect(() => {
    if (sourceOpen) setOpen(false);
  }, [sourceOpen]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !event.composedPath().includes(root.current!) &&
        !event.composedPath().includes(panelRoot.current!)
      ) {
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
    if (query.trim()) return searchMathPalette(catalog, query);
    if (category === "recent" || category === "favorites")
      return preferences[category].map((id) => paletteById.get(id)!).filter(Boolean);
    return mathPaletteGroup(catalog, category);
  }, [category, preferences, query, catalog, paletteById]);
  const active = symbols.find((symbol) => symbol.id === activeId) ?? symbols[0];
  const hasQuery = Boolean(query.trim());
  const categoryLabel = hasQuery
    ? "Search results"
    : category === "recent"
      ? "Recent"
      : category === "favorites"
        ? "Favorites"
        : category === "document"
          ? "Macros"
          : MATH_PALETTE_GROUPS.find(({ id }) => id === category)?.label;
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
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
      return;
    }
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const origin = buttons[index]?.getBoundingClientRect();
    if (!origin) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const x = origin.left + origin.width / 2;
    const y = origin.top + origin.height / 2;
    const next = buttons
      .flatMap((button) => {
        const rect = button.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - x;
        const dy = rect.top + rect.height / 2 - y;
        const along = horizontal ? dx : dy;
        const across = horizontal ? dy : dx;
        return along * direction > 1
          ? [{ button, distance: Math.abs(along) + Math.abs(across) * 3 }]
          : [];
      })
      .sort((left, right) => left.distance - right.distance)[0];
    next?.button.focus();
  };
  const panel = open ? (
    <section
      ref={panelRoot}
      role="dialog"
      data-latex-select-owner={ownerId}
      data-dock-command-scope="latex"
      id={panelId}
      className="scient-latex-symbol-palette-panel"
      aria-label="Symbols"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="scient-latex-symbol-palette-header">
        <strong>Symbols</strong>
        <Button variant="ghost" size="icon-xs" aria-label="Close Symbols" onClick={close}>
          <X />
        </Button>
      </div>
      <div className="scient-latex-symbol-palette-search">
        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={search}
            nativeInput
            size="compact"
            type="search"
            placeholder="Search symbols"
            aria-label="Search symbols"
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
        </InputGroup>
      </div>
      <div className="scient-latex-symbol-palette-body">
        <nav className="scient-latex-symbol-palette-categories" aria-label="Math symbol categories">
          {paletteCategories
            .filter(
              ({ id }) =>
                id !== "document" || catalog.some((symbol) => symbol.category === "document"),
            )
            .map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={!hasQuery && category === id}
                onClick={() => {
                  setCategory(id);
                  setQuery("");
                  setActiveId(null);
                }}
              >
                <Icon aria-hidden="true" />
                {label}
              </button>
            ))}
        </nav>
        <div className="scient-latex-symbol-palette-results">
          <div className="scient-latex-symbol-palette-count">
            {categoryLabel}
            <span>{symbols.length}</span>
          </div>
          <div ref={grid} className="scient-latex-symbol-palette-grid" key={`${category}:${query}`}>
            {symbols.map((symbol, index) => (
              <ScientTooltip
                key={symbol.id}
                content={
                  <SymbolCommand symbol={symbol} shortcuts={shortcuts.get(symbol.id) ?? []} />
                }
              >
                <button
                  type="button"
                  data-symbol=""
                  aria-label={[mathSymbolCommand(symbol), ...(shortcuts.get(symbol.id) ?? [])].join(
                    ", ",
                  )}
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
              {hasQuery
                ? "No matching symbols."
                : category === "favorites"
                  ? "No favorite symbols."
                  : category === "recent"
                    ? "No recent symbols."
                    : "No symbols."}
            </p>
          )}
        </div>
      </div>
      <div className="scient-latex-symbol-palette-detail">
        <div>
          {active && <SymbolCommand symbol={active} shortcuts={shortcuts.get(active.id) ?? []} />}
        </div>
        {active && (
          <Button
            variant={preferences.favorites.includes(active.id) ? "selected" : "ghost"}
            size="icon-xs"
            aria-label={
              preferences.favorites.includes(active.id) ? "Remove favorite" : "Add favorite"
            }
            aria-pressed={preferences.favorites.includes(active.id)}
            onClick={() => {
              const latest = readPreferences(preferences);
              remember({
                ...latest,
                favorites: latest.favorites.includes(active.id)
                  ? latest.favorites.filter((id) => id !== active.id)
                  : [active.id, ...latest.favorites].slice(0, 32),
              });
            }}
          >
            <Star fill={preferences.favorites.includes(active.id) ? "currentColor" : "none"} />
          </Button>
        )}
      </div>
    </section>
  ) : null;
  return (
    <div
      ref={root}
      id={ownerId}
      className="scient-latex-symbol-palette"
      data-dock-command-scope="latex"
    >
      {!picker && showTrigger && (
        <button
          type="button"
          className={dockButtonClass(open)}
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
      )}
      {panel && portalHost ? createPortal(panel, portalHost) : panel}
    </div>
  );
}

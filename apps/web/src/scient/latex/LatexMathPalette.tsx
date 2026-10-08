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
  const dragHandle = useRef<HTMLButtonElement>(null);
  const panelPosition = useRef({ x: 0, y: 0 });
  const [portalHost, setPortalHost] = useState<Element | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setPortalHost(root.current?.closest(".scient-latex-reader-footer") ?? null);
  }, []);
  useLayoutEffect(() => {
    const panel = panelRoot.current;
    const handle = dragHandle.current;
    if (!open || !panel || !handle) return;
    const workspace = root.current?.closest(".scient-latex-visual-workspace");
    const listeners = new AbortController();
    let position = { x: 0, y: 0 };
    let drag: {
      pointerId: number;
      x: number;
      y: number;
      start: { x: number; y: number };
      latest: { x: number; y: number };
    } | null = null;
    let frame = 0;
    const move = (next: { x: number; y: number }) => {
      const bounds = panel.getBoundingClientRect();
      const viewport = workspace?.getBoundingClientRect();
      const left = Math.max(8, (viewport?.left ?? 0) + 8);
      const top = Math.max(8, (viewport?.top ?? 0) + 8);
      const right = Math.min(window.innerWidth, viewport?.right ?? window.innerWidth) - 8;
      const bottom = Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight) - 8;
      const baseLeft = bounds.left - position.x;
      const baseTop = bounds.top - position.y;
      position = {
        x:
          Math.max(left, Math.min(Math.max(left, right - bounds.width), baseLeft + next.x)) -
          baseLeft,
        y:
          Math.max(top, Math.min(Math.max(top, bottom - bounds.height), baseTop + next.y)) -
          baseTop,
      };
      panelPosition.current = position;
      panel.style.translate = `${position.x}px ${position.y}px`;
    };
    const applyPointer = () => {
      frame = 0;
      if (drag)
        move({
          x: drag.start.x + drag.latest.x - drag.x,
          y: drag.start.y + drag.latest.y - drag.y,
        });
    };
    const endDrag = (cancel = false) => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const previous = drag;
      drag = null;
      if (!previous) return;
      if (cancel) move(previous.start);
      panel.removeAttribute("data-dragging");
      if (handle.hasPointerCapture(previous.pointerId))
        handle.releasePointerCapture(previous.pointerId);
    };
    handle.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || !event.isPrimary || drag) return;
        event.preventDefault();
        event.stopPropagation();
        handle.focus({ preventScroll: true });
        drag = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          latest: { x: event.clientX, y: event.clientY },
          start: { ...position },
        };
        panel.setAttribute("data-dragging", "");
        handle.setPointerCapture(event.pointerId);
      },
      { signal: listeners.signal },
    );
    handle.addEventListener(
      "pointermove",
      (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        drag.latest = { x: event.clientX, y: event.clientY };
        if (!frame) frame = requestAnimationFrame(applyPointer);
      },
      { signal: listeners.signal },
    );
    handle.addEventListener(
      "pointerup",
      (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.latest = { x: event.clientX, y: event.clientY };
        if (frame) cancelAnimationFrame(frame);
        applyPointer();
        endDrag();
      },
      { signal: listeners.signal },
    );
    const cancel = (event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) endDrag(true);
    };
    handle.addEventListener("pointercancel", cancel, { signal: listeners.signal });
    handle.addEventListener("lostpointercapture", cancel, { signal: listeners.signal });
    handle.addEventListener(
      "keydown",
      (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "Escape" && drag) {
          event.preventDefault();
          event.stopPropagation();
          endDrag(true);
          return;
        }
        if (
          event.key !== "Home" &&
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        endDrag();
        const step = event.shiftKey ? 1 : 10;
        move(
          event.key === "Home"
            ? { x: 0, y: 0 }
            : {
                x:
                  position.x +
                  (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
                y:
                  position.y +
                  (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
              },
        );
      },
      { signal: listeners.signal },
    );
    const resize = () => move(position);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(panel);
    if (workspace) observer?.observe(workspace);
    window.addEventListener("resize", resize, { signal: listeners.signal });
    move(panelPosition.current);
    return () => {
      endDrag();
      listeners.abort();
      observer?.disconnect();
      panel.style.removeProperty("translate");
    };
  }, [open, portalHost]);
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
        <button
          ref={dragHandle}
          type="button"
          className="scient-latex-symbol-palette-move"
          aria-label="Move Symbols"
        >
          Symbols
        </button>
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

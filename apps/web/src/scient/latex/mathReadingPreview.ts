import { MathfieldElement, type MacroDictionary } from "mathlive";
import type { DocumentMathMacro } from "./latexDocumentMacros";
import { mathSymbolMacros } from "./mathSymbolPresentation";
import staticMathStyles from "mathlive/static.css?inline";
import type { MathPreviewContext, MathPreviewRequest } from "./mathReadingPreviewProtocol";

let previewStyles: CSSStyleSheet | undefined;
let previewStyleText: string | undefined;

function mathReadingStyles() {
  // Every formula uses the same CSS. Strip global font declarations once,
  // including on browsers which need a separate style node per shadow root.
  return (previewStyleText ??= `${staticMathStyles.replace(/@font-face\s*\{[^}]*\}/gu, "")}
    ::selection { background: transparent; color: inherit; }
  `);
}
/** Passive completion state stays inside the shadow root, outside the editor's DOM observer. */
export function mathReadingPreviewReady(element: Element): boolean {
  return (
    element.hasAttribute("data-math-preview-ready") ||
    Boolean(
      element.shadowRoot?.querySelector("[data-math-preview-content][data-math-preview-ready]"),
    )
  );
}

/** Keep mathematical layout independent of prose CSS and document invalidation. */
export function installMathReadingPreview(element: HTMLElement): ShadowRoot {
  const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
  if (root.querySelector("[data-math-preview-content]")) return root;
  // Fonts are already bundled globally by MathLive's fonts.css. Share one
  // parsed layout sheet across previews instead of hundreds of style nodes.
  if (typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype) {
    if (!previewStyles) {
      previewStyles = new CSSStyleSheet();
      previewStyles.replaceSync(mathReadingStyles());
    }
    root.adoptedStyleSheets = [previewStyles];
  } else {
    const style = document.createElement("style");
    style.textContent = mathReadingStyles();
    root.append(style);
  }
  const content = document.createElement("span");
  content.dataset.mathPreviewContent = "";
  root.append(content);
  return root;
}

let defaults: MacroDictionary | undefined;
const dictionaries = new WeakMap<object, MacroDictionary>();

function previewMacros(macros: Readonly<Record<string, DocumentMathMacro>>) {
  const cached = dictionaries.get(macros);
  if (cached) return cached;
  // The static renderer replaces rather than extends its macro dictionary.
  // Obtain the library's defaults once, including built-in aliases, using a
  // temporary connected field. It owns no user input or document listeners.
  if (!defaults) {
    const host = document.createElement("span");
    host.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    const seed = new MathfieldElement();
    host.append(seed);
    document.body.append(host);
    try {
      defaults = { ...seed.macros, ...mathSymbolMacros() };
    } finally {
      host.remove();
    }
  }
  const dictionary = { ...defaults, ...macros };
  dictionaries.set(macros, dictionary);
  return dictionary;
}

type PreviewJob = {
  id: number;
  key: string;
  source: string;
  display: boolean;
  contextId: number;
  context: MathPreviewContext;
  subscribers: Map<symbol, { complete: (markup: string | null) => void; priority: () => number }>;
};
const pending = new Map<number, PreviewJob>();
const requests = new Map<string, PreviewJob>();
const markupCache = new Map<string, string>();
let cacheBytes = 0;
const maximumCacheBytes = 16 * 1024 * 1024;
const maximumCacheEntries = 512;
let worker: Worker | undefined;
let ready = false;
let active: PreviewJob | undefined;
let sequence = 0;
let deadline: ReturnType<typeof setTimeout> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
const contexts = new WeakMap<object, WeakMap<object, { id: number; value: MathPreviewContext }>>();
const equivalentContexts = new Map<string, { id: number; value: MathPreviewContext }>();
const noColors = {};
let contextSequence = 0;
const sentContexts = new Set<number>();

function contextFor(
  macros: Readonly<Record<string, DocumentMathMacro>>,
  colors: Readonly<Record<string, string>> | undefined,
) {
  let byColor = contexts.get(macros);
  if (!byColor) {
    byColor = new WeakMap();
    contexts.set(macros, byColor);
  }
  const colorKey = colors ?? noColors;
  let context = byColor.get(colorKey);
  if (context) return context;
  const signature = JSON.stringify([macros, colors]);
  context = equivalentContexts.get(signature);
  if (!context) {
    context = {
      id: ++contextSequence,
      value: { macros: previewMacros(macros), documentMacros: macros, colors },
    };
    if (equivalentContexts.size >= 16)
      equivalentContexts.delete(equivalentContexts.keys().next().value!);
  } else equivalentContexts.delete(signature);
  equivalentContexts.set(signature, context);
  byColor.set(colorKey, context);
  return context;
}

/** Stable for equivalent immutable document settings, even after source reparsing. */
export function mathReadingPreviewContextId(
  macros: Readonly<Record<string, DocumentMathMacro>>,
  colors: Readonly<Record<string, string>> | undefined,
) {
  return contextFor(macros, colors).id;
}

function stopWorker() {
  clearTimeout(deadline);
  clearTimeout(idle);
  worker?.terminate();
  worker = undefined;
  ready = false;
  sentContexts.clear();
}

function remember(key: string, markup: string) {
  const bytes = (key.length + markup.length) * 2;
  if (bytes > maximumCacheBytes) return;
  const previous = markupCache.get(key);
  if (previous !== undefined) cacheBytes -= (key.length + previous.length) * 2;
  markupCache.delete(key);
  markupCache.set(key, markup);
  cacheBytes += bytes;
  while (cacheBytes > maximumCacheBytes || markupCache.size > maximumCacheEntries) {
    const oldest = markupCache.entries().next().value!;
    cacheBytes -= (oldest[0].length + oldest[1].length) * 2;
    markupCache.delete(oldest[0]);
  }
}

function deliver(job: PreviewJob, markup: string | null) {
  requests.delete(job.key);
  for (const [id, subscriber] of job.subscribers) {
    job.subscribers.delete(id);
    try {
      subscriber.complete(markup);
    } catch (error) {
      // A detached view must not strand every other formula in the queue.
      reportError(error);
    }
  }
}

function finish(markup: string | null) {
  clearTimeout(deadline);
  const job = active;
  active = undefined;
  try {
    if (job) {
      if (markup !== null) remember(job.key, markup);
      deliver(job, markup);
    }
  } finally {
    pump();
  }
}

function pump() {
  if (active) return;
  clearTimeout(idle);
  if (pending.size === 0) {
    // Keep the converter warm across ordinary view switches, then release it.
    idle = setTimeout(stopWorker, 30_000);
    return;
  }
  if (!worker) {
    try {
      worker = new Worker(new URL("./mathReadingPreview.worker.ts", import.meta.url), {
        type: "module",
      });
      const owner = worker;
      worker.addEventListener(
        "message",
        (event: MessageEvent<{ ready?: boolean; id?: number; markup?: string | null }>) => {
          if (worker !== owner) return;
          if (event.data.ready) {
            clearTimeout(deadline);
            ready = true;
            pump();
          } else if (event.data.id === active?.id) finish(event.data.markup ?? null);
        },
      );
      const unavailable = () => {
        if (worker !== owner) return;
        stopWorker();
        const jobs = [...pending.values()];
        pending.clear();
        const current = active;
        active = undefined;
        if (current) deliver(current, null);
        for (const job of jobs) deliver(job, null);
      };
      worker.addEventListener("error", (event) => {
        event.preventDefault();
        unavailable();
      });
      deadline = setTimeout(unavailable, import.meta.env.DEV ? 60_000 : 15_000);
    } catch {
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) deliver(job, null);
    }
    return;
  }
  if (!ready) return;
  let maximum = -Infinity;
  for (const job of pending.values()) {
    let priority = -Infinity;
    for (const subscriber of job.subscribers.values())
      priority = Math.max(priority, subscriber.priority());
    if (priority > maximum) {
      active = job;
      maximum = priority;
    }
  }
  if (!active) return;
  pending.delete(active.id);
  // Bound a pathological formula without blocking the renderer or losing its
  // source. The remaining formulas resume in a fresh worker.
  deadline = setTimeout(() => {
    stopWorker();
    finish(null);
  }, 3000);
  try {
    const resetContexts = sentContexts.size >= 16 && !sentContexts.has(active.contextId);
    // Send a document's dictionary once per worker, rather than cloning the
    // full dictionary hundreds of times while its formulas open.
    const input: MathPreviewRequest = {
      id: active.id,
      source: active.source,
      display: active.display,
      contextId: active.contextId,
      ...(resetContexts ? { resetContexts: true } : {}),
      ...(!sentContexts.has(active.contextId) ? { context: active.context } : {}),
    };
    worker.postMessage(input, []);
    if (resetContexts) sentContexts.clear();
    sentContexts.add(active.contextId);
  } catch {
    finish(null);
  }
}

/** Share immutable markup and in-flight work; cancellation belongs to each view. */
export function mathReadingPreview(
  source: string,
  display: boolean,
  macros: Readonly<Record<string, DocumentMathMacro>>,
  colors: Readonly<Record<string, string>> | undefined,
  complete: (markup: string | null) => void,
  priority: () => number = () => 0,
) {
  const context = contextFor(macros, colors);
  const key = JSON.stringify([context.id, display, source]);
  const cached = markupCache.get(key);
  if (cached !== undefined) {
    markupCache.delete(key);
    markupCache.set(key, cached);
    complete(cached);
    return () => {};
  }
  let job = requests.get(key);
  if (!job) {
    job = {
      id: ++sequence,
      key,
      source,
      display,
      contextId: context.id,
      context: context.value,
      subscribers: new Map(),
    };
    requests.set(key, job);
    pending.set(job.id, job);
  }
  const subscriber = Symbol();
  job.subscribers.set(subscriber, { complete, priority });
  pump();
  return () => {
    if (!job.subscribers.delete(subscriber)) return;
    if (job.subscribers.size) return;
    pending.delete(job.id);
    if (requests.get(key) === job) requests.delete(key);
    if (active === job) {
      // A converter cannot process a cancellation while stuck in synchronous
      // expansion. Release its owner and resume other views in a fresh worker;
      // late responses from the terminated worker are already owner-guarded.
      active = undefined;
      stopWorker();
      pump();
    } else if (pending.size === 0 && !active) stopWorker();
  };
}

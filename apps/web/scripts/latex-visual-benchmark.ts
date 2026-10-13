// Measures the Visual LaTeX editor in a production build: opening, scrolling,
// typing, structural edits and memory (one and three documents open, peak and
// steady, repeated open/close), against the gates in
// docs/internals/scient-latex-visual-performance.md.
//
//   node apps/web/scripts/latex-visual-benchmark.ts [--fixture file.tex] [--pages 100]
//     [--scenarios open,scroll,typing,structure,memory] [--cycles 10] [--skip-build]
//     [--json out.json] [--shots dir] [--headed] [--dpr 1] [--profile open|typing|structure]
//
// A fixture path is read locally and never copied; without one, a deterministic
// synthetic manuscript of --pages pages is used.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { chromium, type CDPSession, type Page } from "playwright";

const web = NodePath.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const scenarios = new Set(
  (option("scenarios") ?? "open,scroll,typing,structure,memory").split(","),
);
const out = option("out") ?? NodePath.join(NodeOS.tmpdir(), "scient-latex-visual-benchmark");
const shots = option("shots");

if (!flag("skip-build")) {
  const result = NodeChildProcess.spawnSync(
    NodePath.join(web, "../../node_modules/.bin/vp"),
    ["build", "--config", "latexVisualBenchmark.config.ts"],
    {
      cwd: web,
      env: { ...process.env, SCIENT_LATEX_BENCHMARK_OUT: out },
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error(`Benchmark build failed:\n${result.stdout}\n${result.stderr}`);
}

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = NodeHttp.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const relative = url.pathname === "/" ? "latex-visual-benchmark.html" : url.pathname.slice(1);
  const file = NodePath.join(out, decodeURIComponent(relative));
  if (!file.startsWith(out) || !NodeFS.existsSync(file) || NodeFS.statSync(file).isDirectory()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": types[NodePath.extname(file)] ?? "application/octet-stream",
  });
  NodeFS.createReadStream(file).pipe(response);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

/** Installed before the app: frame, input and scroll-write instrumentation. */
function instrument() {
  type Bench = {
    loaf: { start: number; duration: number; blocking: number; scripts: string[] }[];
    events: { name: string; start: number; duration: number; interaction: number }[];
    scrolls: { t: number; kind: string; delta: number; caret: boolean; stack: string }[];
    harness: boolean;
  };
  const bench: Bench = { loaf: [], events: [], scrolls: [], harness: false };
  Object.assign(window, { __bench: bench });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & {
      blockingDuration: number;
      scripts: {
        invoker: string;
        sourceFunctionName: string;
        sourceURL: string;
        duration: number;
      }[];
    })[])
      bench.loaf.push({
        start: entry.startTime,
        duration: entry.duration,
        blocking: entry.blockingDuration,
        scripts: entry.scripts
          .toSorted((a, b) => b.duration - a.duration)
          .slice(0, 3)
          .map(
            (script) =>
              `${Math.round(script.duration)}ms ${script.invoker} ${script.sourceFunctionName || "?"}`,
          ),
      });
  }).observe({ type: "long-animation-frame", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { interactionId: number })[])
      bench.events.push({
        name: entry.name,
        start: entry.startTime,
        duration: entry.duration,
        interaction: entry.interactionId,
      });
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  const scroller = (element: Element) =>
    element instanceof HTMLElement && element.classList.contains("scient-latex-visual-scroll");
  const record = (element: Element, kind: string, next: number) => {
    if (bench.harness || !scroller(element)) return;
    const stack = new Error().stack ?? "";
    bench.scrolls.push({
      t: performance.now(),
      kind,
      delta: next - element.scrollTop,
      caret: /scrollRectIntoView|scrollToSelection/.test(stack),
      stack: stack
        .split("\n")
        .slice(2, 7)
        .map((line) => line.trim())
        .join(" | "),
    });
  };
  const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get() {
      return top.get!.call(this);
    },
    set(value: number) {
      record(this, "scrollTop", value);
      top.set!.call(this, value);
    },
  });
  for (const method of ["scrollTo", "scroll", "scrollBy"] as const) {
    const original = Element.prototype[method];
    Element.prototype[method] = function (this: Element, ...args: unknown[]) {
      const first = args[0];
      const y =
        typeof first === "object" && first !== null
          ? Number((first as ScrollToOptions).top ?? this.scrollTop)
          : Number(args[1] ?? this.scrollTop);
      record(this, method, method === "scrollBy" ? this.scrollTop + y : y);
      return (original as (...values: unknown[]) => void).apply(this, args);
    } as never;
  }
  const into = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, ...args: unknown[]) {
    const container = this.closest(".scient-latex-visual-scroll");
    if (container) record(container, "scrollIntoView", container.scrollTop);
    return (into as (...values: unknown[]) => void).apply(this, args);
  } as never;
}

/** Page-side readiness of what the reader can see now. Cheap: it inspects only
 * the top-level blocks that intersect the viewport, found by binary search. */
function visibleState() {
  const editor = (
    window as unknown as { latexBenchmark: { editor(): any } }
  ).latexBenchmark.editor();
  const scroll = editor?.view.dom.closest(".scient-latex-visual-scroll") as HTMLElement | null;
  if (!editor || !scroll) return { exists: false, ready: false, editable: false };
  const box = scroll.getBoundingClientRect();
  const blocks = [...(editor.view.dom as HTMLElement).children] as HTMLElement[];
  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle]!.getBoundingClientRect().bottom <= box.top) low = middle + 1;
    else high = middle;
  }
  const visible: HTMLElement[] = [];
  for (let index = low; index < blocks.length; index++) {
    const rect = blocks[index]!.getBoundingClientRect();
    if (rect.top >= box.bottom) break;
    if (rect.height > 0) visible.push(blocks[index]!);
  }
  const within = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
  };
  let closed = 0;
  let hidden = 0;
  let math = 0;
  for (const block of visible) {
    // Closed and hidden blocks only occur in builds before continuous paper.
    if (block.hasAttribute("data-latex-viewport-closed")) closed++;
    else if (getComputedStyle(block).visibility === "hidden") hidden++;
    for (const element of block.matches(".node-latexDisplayMath, .node-latexInlineMath")
      ? [block]
      : block.querySelectorAll(".node-latexInlineMath, .node-latexDisplayMath")) {
      if (element.querySelector("math-field") || !within(element)) continue;
      const preview = element.querySelector(".scient-latex-math-preview");
      const ready =
        preview?.hasAttribute("data-math-preview-ready") ||
        (preview?.shadowRoot ?? preview)
          ?.querySelector("[data-math-preview-content]")
          ?.hasAttribute("data-math-preview-ready");
      if (!ready) math++;
    }
  }
  const busy = [...scroll.querySelectorAll("[aria-busy='true']")].filter(within).length;
  const text = visible.some((block) => (block.textContent ?? "").trim().length > 0);
  const opening = editor.view.dom.dataset.latexOpening === "true";
  const loading = editor.view.dom.dataset.latexLoading === "true";
  return {
    exists: true,
    ready: text && !opening && closed + busy + hidden + math === 0,
    editable: editor.view.editable && !loading && !opening,
    loading,
    closed,
    busy,
    hidden,
    math,
    scrollHeight: scroll.scrollHeight,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;

async function frames(page: Page, from: number, to?: number) {
  return page.evaluate(
    ([start, end]) => {
      const bench = (
        window as unknown as {
          __bench: {
            loaf: { start: number; duration: number; blocking: number; scripts: string[] }[];
          };
        }
      ).__bench;
      const entries = bench.loaf.filter(
        (entry) => entry.start >= start && (end === null || entry.start <= end),
      );
      return {
        longFrames: entries.length,
        maxFrameMs: Math.round(Math.max(0, ...entries.map((entry) => entry.duration))),
        blockingMs: Math.round(entries.reduce((sum, entry) => sum + entry.blocking, 0)),
        worst: entries
          .toSorted((a, b) => b.duration - a.duration)
          .slice(0, 3)
          .map((entry) => `${Math.round(entry.duration)}ms: ${entry.scripts.join("; ")}`),
      };
    },
    [from, to ?? null] as const,
  );
}

async function open(page: Page, source: string, key: string, settle = true) {
  const t0 = await page.evaluate(
    ([text, draft]) => {
      const start = performance.now();
      (
        window as unknown as { latexBenchmark: { open(source: string, key: string): void } }
      ).latexBenchmark.open(text, draft);
      return start;
    },
    [source, key] as const,
  );
  let firstReadable = NaN;
  let editable = NaN;
  for (;;) {
    const state = await page.evaluate(visibleState);
    const now = await page.evaluate(() => performance.now());
    if (state.ready && Number.isNaN(firstReadable)) firstReadable = now - t0;
    if (state.ready && state.editable && Number.isNaN(editable)) editable = now - t0;
    if (!Number.isNaN(editable) || now - t0 > 120_000) break;
    await page.waitForTimeout(50);
  }
  // Settled: no long frame for 3 s and the whole document loaded.
  let settled = editable;
  if (settle)
    for (;;) {
      const quiet = await page.evaluate(() => {
        const bench = (
          window as unknown as { __bench: { loaf: { start: number; duration: number }[] } }
        ).__bench;
        const last = bench.loaf.at(-1);
        return { now: performance.now(), lastEnd: last ? last.start + last.duration : 0 };
      });
      const state = await page.evaluate(visibleState);
      if (quiet.lastEnd > t0) settled = Math.max(settled, quiet.lastEnd - t0);
      if (quiet.now - Math.max(quiet.lastEnd, t0 + editable) > 3000 && !state.loading) break;
      if (quiet.now - t0 > 180_000) break;
      await page.waitForTimeout(200);
    }
  // Every formula rendered (they render visible-first in a worker).
  let formulasReady = NaN;
  for (;;) {
    const formulas = await page.evaluate(() => {
      const previews = [...document.querySelectorAll(".scient-latex-math-preview")];
      return {
        now: performance.now(),
        pending: previews.filter(
          (preview) =>
            !(preview.shadowRoot ?? preview)
              .querySelector("[data-math-preview-content]")
              ?.hasAttribute("data-math-preview-ready"),
        ).length,
      };
    });
    if (formulas.pending === 0) {
      formulasReady = formulas.now - t0;
      break;
    }
    if (formulas.now - t0 > 120_000) break;
    await page.waitForTimeout(250);
  }
  const published = await page.evaluate(
    () => (window as unknown as { latexBenchmark: { published: string } }).latexBenchmark.published,
  );
  return {
    t0,
    firstReadableMs: Math.round(firstReadable),
    editableMs: Math.round(editable),
    settledMs: Math.round(settled),
    formulasReadyMs: Math.round(formulasReady),
    sourceUnchanged: published === source,
    ...(await frames(page, t0)),
  };
}

async function jump(page: Page, fraction: number) {
  const before = await page.evaluate(
    () => (window as unknown as { __bench: { scrolls: unknown[] } }).__bench.scrolls.length,
  );
  const result = await page.evaluate(async (target) => {
    const bench = (window as unknown as { __bench: { harness: boolean } }).__bench;
    const editor = (
      window as unknown as { latexBenchmark: { editor(): any } }
    ).latexBenchmark.editor();
    const view = editor.view;
    const scroll = view.dom.closest(".scient-latex-visual-scroll") as HTMLElement;
    const t0 = performance.now();
    bench.harness = true;
    scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) * target);
    bench.harness = false;
    // Drift is measured from the first frame painted after the jump: the
    // reader never sees the layout before it.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const set = scroll.scrollTop;
    const box = scroll.getBoundingClientRect();
    const paper = view.dom.getBoundingClientRect();
    let anchor: number | undefined;
    try {
      anchor = view.posAtCoords({
        left: paper.left + paper.width / 2,
        top: box.top + box.height / 2,
      })?.pos;
    } catch {}
    const top = () => {
      try {
        return anchor === undefined ? NaN : view.coordsAtPos(anchor).top;
      } catch {
        return NaN;
      }
    };
    const top0 = top();
    let drift = 0;
    return { t0, set, top0, anchor, drift };
  }, fraction);
  let ready = NaN;
  let drift = 0;
  for (;;) {
    const sample = await page.evaluate(
      ([anchor, top0]) => {
        const editor = (
          window as unknown as { latexBenchmark: { editor(): any } }
        ).latexBenchmark.editor();
        let top = NaN;
        try {
          top = anchor === null ? NaN : editor.view.coordsAtPos(anchor).top;
        } catch {}
        return {
          now: performance.now(),
          drift: Number.isFinite(top) && Number.isFinite(top0) ? Math.abs(top - top0) : 0,
        };
      },
      [result.anchor ?? null, result.top0] as const,
    );
    drift = Math.max(drift, sample.drift);
    const state = await page.evaluate(visibleState);
    if (state.ready) {
      ready = sample.now - result.t0;
      break;
    }
    if (sample.now - result.t0 > 30_000) break;
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(600);
  const after = await page.evaluate(
    ([anchor, top0, from]) => {
      const editor = (
        window as unknown as { latexBenchmark: { editor(): any } }
      ).latexBenchmark.editor();
      const bench = (window as unknown as { __bench: { scrolls: { delta: number }[] } }).__bench;
      let top = NaN;
      try {
        top = anchor === null ? NaN : editor.view.coordsAtPos(anchor).top;
      } catch {}
      return {
        drift: Number.isFinite(top) && Number.isFinite(top0) ? Math.abs(top - top0) : 0,
        writes: bench.scrolls.slice(from).length,
      };
    },
    [result.anchor ?? null, result.top0, before] as const,
  );
  return {
    fraction,
    readyMs: Math.round(ready),
    contentDriftPx: round(Math.max(drift, after.drift)),
    appScrollWrites: after.writes,
    ...(await frames(page, result.t0)),
  };
}

/** Places the caret in visible prose near `fraction`; returns the paragraph position. */
async function placeCaret(page: Page, fraction: number) {
  // Try nearby positions until a prose paragraph sits below visible content.
  for (const offset of [0, 0.02, 0.04, 0.06, 0.08, 0.1, -0.02, -0.04]) {
    await jump(page, Math.min(0.98, Math.max(0.02, fraction + offset)));
    await page.waitForTimeout(500);
    const found = await page.evaluate(() => {
      const editor = (
        window as unknown as { latexBenchmark: { editor(): any } }
      ).latexBenchmark.editor();
      const view = editor.view;
      const scroll = view.dom.closest(".scient-latex-visual-scroll") as HTMLElement;
      const box = scroll.getBoundingClientRect();
      let result: { position: number; caret: number; reference: number } | null = null;
      view.state.doc.descendants((node: any, offset: number) => {
        if (result) return false;
        if (node.type.name !== "paragraph" || node.textContent.length < 100) return;
        const element = view.nodeDOM(offset) as HTMLElement | null;
        const rect = element?.getBoundingClientRect();
        if (!rect || rect.top < box.top + box.height * 0.1 || rect.top > box.top + box.height * 0.8)
          return false;
        const walker = document.createTreeWalker(element!, NodeFilter.SHOW_TEXT);
        let text: Text | null;
        while ((text = walker.nextNode() as Text | null))
          if (
            text.data.length > 30 &&
            !text.parentElement?.closest(
              ".scient-latex-math-preview, math-field, [contenteditable='false']",
            )
          )
            break;
        if (!text) return false;
        // Unchanged content: the last top-level block wholly visible above it.
        let reference: number | null = null;
        view.state.doc.forEach((_block: any, blockOffset: number) => {
          const blockRect = (
            view.nodeDOM(blockOffset) as HTMLElement | null
          )?.getBoundingClientRect();
          if (blockRect && blockRect.top >= box.top && blockRect.bottom <= rect.top - 1)
            reference = blockOffset;
        });
        if (reference === null) return false;
        const space = text.data.indexOf(" ", 10);
        result = {
          position: offset,
          caret: view.posAtDOM(text, space < 0 ? 10 : space),
          reference,
        };
        return false;
      });
      if (!result) return null;
      const found = result as { position: number; caret: number; reference: number };
      const selection = editor.state.selection.constructor;
      view.dispatch(
        view.state.tr.setSelection((selection as any).near(view.state.doc.resolve(found.caret))),
      );
      view.focus();
      return found;
    });
    if (found) return found;
  }
  return null;
}

/** Samples, every frame, unchanged content above the edit and the edited paragraph. */
async function startStability(page: Page, target: { position: number; reference: number | null }) {
  await page.evaluate((input) => {
    const editor = (
      window as unknown as { latexBenchmark: { editor(): any } }
    ).latexBenchmark.editor();
    const view = editor.view;
    const state = {
      samples: [] as { t: number; reference: number; paragraph: number }[],
      running: true,
    };
    Object.assign(window, { __stability: state });
    const top = (position: number | null) => {
      if (position === null) return NaN;
      const element = view.nodeDOM(position);
      return element instanceof HTMLElement ? element.getBoundingClientRect().top : NaN;
    };
    const sample = () => {
      if (!state.running) return;
      state.samples.push({
        t: performance.now(),
        reference: top(input.reference),
        paragraph: top(input.position),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, target);
}
async function stopStability(page: Page, since: number) {
  return page.evaluate((from) => {
    const state = (
      window as unknown as {
        __stability: {
          samples: { t: number; reference: number; paragraph: number }[];
          running: boolean;
        };
      }
    ).__stability;
    state.running = false;
    const bench = (
      window as unknown as {
        __bench: { scrolls: { t: number; caret: boolean; delta: number; stack: string }[] };
      }
    ).__bench;
    const first = state.samples.find((sample) => Number.isFinite(sample.reference));
    const moved = (key: "reference" | "paragraph") => {
      const base = state.samples.find((sample) => Number.isFinite(sample[key]))?.[key] ?? NaN;
      return Math.max(
        0,
        ...state.samples
          .filter((sample) => Number.isFinite(sample[key]))
          .map((sample) => Math.abs(sample[key] - base)),
      );
    };
    const writes = bench.scrolls.filter((write) => write.t >= from);
    return {
      unchangedContentMovedPx: first ? Math.round(moved("reference") * 10) / 10 : null,
      editedParagraphMovedPx: Math.round(moved("paragraph") * 10) / 10,
      caretFollowScrolls: writes.filter((write) => write.caret).length,
      otherScrollWrites: writes.filter((write) => !write.caret).length,
      otherScrollStacks: writes
        .filter((write) => !write.caret)
        .slice(0, 3)
        .map((write) => write.stack),
    };
  }, since);
}

async function interactions(page: Page, from: number, keys: number) {
  return page.evaluate(
    ([start, count]) => {
      const bench = (
        window as unknown as {
          __bench: {
            events: { name: string; start: number; duration: number; interaction: number }[];
          };
        }
      ).__bench;
      const byInteraction = new Map<number, number>();
      for (const event of bench.events)
        if (event.start >= start && event.interaction)
          byInteraction.set(
            event.interaction,
            Math.max(byInteraction.get(event.interaction) ?? 0, event.duration),
          );
      const slow = [...byInteraction.values()];
      // Event Timing reports only interactions of at least 16 ms: the others
      // are known to be faster, not how much faster. A percentile among them
      // is reported as "<16".
      const fast = Math.max(0, count - slow.length);
      const sorted = [...Array.from({ length: fast }, () => 0), ...slow].toSorted((a, b) => a - b);
      const at = (p: number) => {
        const value = sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
        return value === 0 ? "<16" : value;
      };
      return {
        keys: count,
        under16: fast,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        maxMs: at(1),
        over32: slow.filter((d) => d > 32).length,
      };
    },
    [from, keys] as const,
  );
}

const now = (page: Page) => page.evaluate(() => performance.now());

type ProfileNode = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
};
/** Starts a sampling CPU profile when --profile names this scenario. */
async function profile(cdp: CDPSession, scenario: string) {
  if (option("profile") !== scenario) return async () => null;
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
  await cdp.send("Profiler.start");
  return async () => {
    const { profile: result } = (await cdp.send("Profiler.stop")) as {
      profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
    };
    const self = new Map<number, number>();
    result.samples.forEach((id, index) =>
      self.set(id, (self.get(id) ?? 0) + (result.timeDeltas[index] ?? 0) / 1000),
    );
    const nodes = new Map(result.nodes.map((node) => [node.id, node]));
    const parents = new Map<number, number>();
    for (const node of result.nodes)
      for (const child of node.children ?? []) parents.set(child, node.id);
    const name = (node: ProfileNode) =>
      `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url.split("/").at(-1)?.split("?")[0] ?? ""}:${node.callFrame.lineNumber + 1}`;
    const selfTotals = new Map<string, number>();
    const inclusive = new Map<string, number>();
    for (const [id, ms] of self) {
      const node = nodes.get(id)!;
      selfTotals.set(name(node), (selfTotals.get(name(node)) ?? 0) + ms);
      const seen = new Set<string>();
      for (
        let current: number | undefined = id;
        current !== undefined;
        current = parents.get(current)
      ) {
        const key = name(nodes.get(current)!);
        if (seen.has(key)) continue;
        seen.add(key);
        inclusive.set(key, (inclusive.get(key) ?? 0) + ms);
      }
    }
    const top = (values: Map<string, number>, count: number) =>
      [...values]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([key, ms]) => `${Math.round(ms)}ms ${key}`);
    return { self: top(selfTotals, 40), inclusive: top(inclusive, 80) };
  };
}

async function typing(page: Page) {
  const target = await placeCaret(page, 0.3);
  if (!target) return { error: "no visible prose paragraph" };
  await page.waitForTimeout(800);
  await startStability(page, target);
  const start = await now(page);
  const text = "the quick brown fox jumps over the lazy dog while the decoder waits ";
  await page.keyboard.type(text, { delay: 45 });
  await page.waitForTimeout(1500);
  const typed = await now(page);
  return {
    typing: await interactions(page, start, text.length),
    frames: await frames(page, start, typed),
    stability: await stopStability(page, start),
  };
}

async function structure(page: Page, original: string) {
  const target = await placeCaret(page, 0.45);
  if (!target) return { error: "no visible prose paragraph" };
  await page.waitForTimeout(800);
  await startStability(page, target);
  const start = await now(page);
  let keys = 0;
  const press = async (key: string) => {
    await page.keyboard.press(key);
    keys++;
    await page.waitForTimeout(60);
  };
  await press("Enter");
  for (const character of "A new paragraph.") {
    await page.keyboard.type(character);
    keys++;
    await page.waitForTimeout(45);
  }
  for (let index = 0; index < 17; index++) await press("Backspace");
  await press("Enter");
  await press("Backspace");
  await page.waitForTimeout(1500);
  for (let index = 0; index < 40; index++) await press("ControlOrMeta+z");
  await page.waitForTimeout(2500);
  const undone = await page.evaluate(
    () => (window as unknown as { latexBenchmark: { published: string } }).latexBenchmark.published,
  );
  await press("ControlOrMeta+Shift+z");
  await page.waitForTimeout(1500);
  const end = await now(page);
  return {
    edits: await interactions(page, start, keys),
    frames: await frames(page, start, end),
    stability: await stopStability(page, start),
    undoRestoresSource: undone === original,
  };
}

async function memory(page: Page, cdp: CDPSession, browserCdp: CDPSession, source: string) {
  /** Resident memory of the renderer processes: native DOM, style, layout and JS together. */
  const rendererMB = async () => {
    try {
      const { processInfo } = (await browserCdp.send("SystemInfo.getProcessInfo")) as {
        processInfo: { type: string; id: number }[];
      };
      const ids = processInfo.filter((entry) => entry.type === "renderer").map((entry) => entry.id);
      if (!ids.length) return null;
      const rss = NodeChildProcess.execFileSync("ps", ["-o", "rss=", "-p", ids.join(",")], {
        encoding: "utf8",
      });
      return round(
        rss
          .split("\n")
          .map((line) => Number(line.trim()) || 0)
          .reduce((sum, kilobytes) => sum + kilobytes, 0) / 1024,
      );
    } catch {
      return null;
    }
  };
  const metrics = async () => {
    const { metrics: entries } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    const metric = (name: string) => entries.find((entry) => entry.name === name)?.value ?? 0;
    return {
      heapMB: round(metric("JSHeapUsedSize") / 1048576),
      rendererMB: await rendererMB(),
      nodes: metric("Nodes"),
      listeners: metric("JSEventListeners"),
    };
  };
  /** Steady memory, after garbage collection. */
  const sample = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(300);
    await cdp.send("HeapProfiler.collectGarbage");
    return metrics();
  };
  /** The highest memory while `until` is false, sampled every 100 ms. */
  const peak = async (until: () => Promise<boolean>) => {
    let heapMB = 0;
    let rendererPeakMB = 0;
    let nodes = 0;
    const started = Date.now();
    while (!(await until()) && Date.now() - started < 180_000) {
      const now = await metrics();
      heapMB = Math.max(heapMB, now.heapMB);
      rendererPeakMB = Math.max(rendererPeakMB, now.rendererMB ?? 0);
      nodes = Math.max(nodes, now.nodes);
      await page.waitForTimeout(100);
    }
    return { heapMB, rendererMB: rendererPeakMB, nodes };
  };
  /** Every document loaded and every formula rendered. */
  const loaded = (count: number) => () =>
    page.evaluate((expected) => {
      const documents = [...document.querySelectorAll(".scient-latex-visual-document")];
      return (
        documents.length === expected &&
        documents.every((element) => !element.hasAttribute("data-latex-loading")) &&
        [...document.querySelectorAll(".scient-latex-math-preview")].every((preview) =>
          (preview.shadowRoot ?? preview)
            .querySelector("[data-math-preview-content]")
            ?.hasAttribute("data-math-preview-ready"),
        )
      );
    }, count);
  const settle = () => page.waitForTimeout(5000);
  const close = () =>
    page.evaluate(() =>
      (window as unknown as { latexBenchmark: { close(): void } }).latexBenchmark.close(),
    );

  // One document, then three at once: peak while opening, steady once settled.
  const baseline = await sample();
  await page.evaluate(
    ([text]) =>
      (
        window as unknown as { latexBenchmark: { open(source: string, key: string): void } }
      ).latexBenchmark.open(text, "benchmark-memory-one"),
    [source] as const,
  );
  const onePeak = await peak(loaded(1));
  await settle();
  const one = { peak: onePeak, steady: await sample() };
  await close();
  await page.evaluate(
    ([text]) =>
      (
        window as unknown as {
          latexBenchmark: { openMany(source: string, keys: readonly string[]): void };
        }
      ).latexBenchmark.openMany(text, [
        "benchmark-memory-a",
        "benchmark-memory-b",
        "benchmark-memory-c",
      ]),
    [source] as const,
  );
  const threePeak = await peak(loaded(3));
  await settle();
  const three = { peak: threePeak, steady: await sample() };
  await close();

  // Repeated open/close: memory returns to the same level.
  const cycles = [];
  const total = Number(option("cycles") ?? 10);
  for (let cycle = 0; cycle < total; cycle++) {
    await open(page, source, `benchmark-memory-${cycle}`, false);
    await page.waitForTimeout(5000);
    const opened = await sample();
    await page.evaluate(() =>
      (window as unknown as { latexBenchmark: { close(): void } }).latexBenchmark.close(),
    );
    await page.waitForTimeout(500);
    cycles.push({ opened, closed: await sample() });
  }
  return {
    baseline,
    one,
    three,
    first: cycles[0],
    last: cycles.at(-1),
    heapGrowthMB: round(cycles.at(-1)!.closed.heapMB - cycles[1]!.closed.heapMB),
    nodeGrowth: cycles.at(-1)!.closed.nodes - cycles[1]!.closed.nodes,
  };
}

const browser = await chromium.launch({ headless: !flag("headed") });
const context = await browser.newContext({
  viewport: { width: 1300, height: 950 },
  deviceScaleFactor: Number(option("dpr") ?? 1),
});
await context.addInitScript(instrument);
const page = await context.newPage();
page.on("pageerror", (error) => console.error("[page error]", error.message));
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => "latexBenchmark" in window);
await page.evaluate(() => {
  const host = document.getElementById("root")!;
  host.style.cssText = "display:flex;flex-direction:column;width:1100px;height:900px";
});

const fixture = option("fixture");
const source = fixture
  ? NodeFS.readFileSync(fixture, "utf8")
  : await page.evaluate(
      (pages) =>
        (
          window as unknown as { latexBenchmark: { synthetic(options: { pages: number }): string } }
        ).latexBenchmark.synthetic({ pages }),
      Number(option("pages") ?? 100),
    );

const report: Record<string, unknown> = {
  fixture: fixture ? NodePath.basename(fixture) : `synthetic-${option("pages") ?? 100}`,
  bytes: source.length,
};
const stopOpenProfile = await profile(cdp, "open");
const opening = await open(page, source, "benchmark");
report.open = { ...opening, profile: await stopOpenProfile() };
if (shots) {
  NodeFS.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: NodePath.join(shots, "open.png") });
}
if (scenarios.has("scroll")) {
  const jumps = [];
  for (const fraction of [0.25, 0.5, 0.75, 0.95, 0.1]) {
    jumps.push(await jump(page, fraction));
    await page.waitForTimeout(1000);
  }
  report.scroll = jumps;
}
if (scenarios.has("typing")) {
  const stopTypingProfile = await profile(cdp, "typing");
  report.typing = { ...(await typing(page)), profile: await stopTypingProfile() };
  if (shots) await page.screenshot({ path: NodePath.join(shots, "typing.png") });
}
if (scenarios.has("structure")) {
  // Reopen so Undo history covers only this scenario.
  await open(page, source, "benchmark-structure");
  const stopStructureProfile = await profile(cdp, "structure");
  report.structure = { ...(await structure(page, source)), profile: await stopStructureProfile() };
  if (shots) await page.screenshot({ path: NodePath.join(shots, "structure.png") });
}
if (scenarios.has("memory"))
  report.memory = await memory(page, cdp, await browser.newBrowserCDPSession(), source);

await browser.close();
server.close();

const json = JSON.stringify(report, null, 2);
const jsonPath = option("json");
if (jsonPath) NodeFS.writeFileSync(jsonPath, `${json}\n`);
console.log(json);

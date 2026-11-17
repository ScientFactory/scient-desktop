// @effect-diagnostics nodeBuiltinImport:off - Vitest loads this outside the app runtime.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import {
  playwright,
  PlaywrightBrowserProvider,
  type PlaywrightProviderOptions,
} from "vite-plus/test/browser-playwright";
import type { TestProject } from "vite-plus/test/node";

const BROWSER_API_PATH = "/__vitest_browser_api__";
const RING_EVENTS = 200;
const TAIL_EVENTS = 100;
export const MAX_REPORT_BYTES = 64 * 1024;

type SocketRole = "tester" | "orchestrator" | "other";
type NavigationCategory = "about-blank" | "same-document" | "same-origin" | "other-origin";
type Disposition = "routine" | "expected" | "unexplained";

/** Only fixed names, small ordinals and allowlisted error labels: nothing from a URL or payload. */
export type LifecycleEvent =
  | { readonly kind: "open-start"; readonly session: number; readonly replacing: boolean }
  | { readonly kind: "open-end"; readonly session: number }
  | { readonly kind: "open-rejected"; readonly session: number; readonly error: string }
  | { readonly kind: "page-close" | "page-crash" | "page-missing"; readonly session: number }
  | { readonly kind: "navigation"; readonly session: number; readonly category: NavigationCategory }
  | {
      readonly kind: "socket-open";
      readonly role: SocketRole;
      readonly socket: number;
      readonly session: number | null;
    }
  | {
      readonly kind: "socket-close";
      readonly role: SocketRole;
      readonly socket: number;
      readonly session: number | null;
      readonly hadError: boolean;
    }
  | {
      readonly kind: "socket-error";
      readonly role: SocketRole;
      readonly socket: number;
      readonly error: string;
    }
  | { readonly kind: "server-error"; readonly error: string }
  | {
      readonly kind:
        | "browser-disconnected"
        | "server-close"
        | "server-unavailable"
        | "provider-close";
    };

type Entry = LifecycleEvent & {
  readonly seq: number;
  readonly ms: number;
  readonly disposition: Disposition;
};

const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "TargetClosedError",
]);

/** An error's code (`ECONNRESET`) or a known class name; never its message. */
export const errorLabel = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "other";
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/u.test(code)) return code;
  return typeof name === "string" && ERROR_NAMES.has(name) ? name : "other";
};

/** Where the main frame went, relative to the page Vitest opened. */
export const navigationCategory = (url: string, opened: string): NavigationCategory => {
  if (url.startsWith("about:blank")) return "about-blank";
  try {
    const next = new URL(url),
      start = new URL(opened);
    if (next.origin !== start.origin) return "other-origin";
    return next.pathname === start.pathname ? "same-document" : "same-origin";
  } catch {
    return "other-origin";
  }
};

/** The role an upgrade request asks for; its session id stays in memory for ordinals only. */
export const upgradeRole = (
  url: string | undefined,
): { readonly role: SocketRole; readonly sessionId: string | null } => {
  try {
    const { pathname, searchParams } = new URL(url ?? "", "http://localhost");
    const type = searchParams.get("type");
    if (pathname !== BROWSER_API_PATH || (type !== "tester" && type !== "orchestrator"))
      return { role: "other", sessionId: null };
    return { role: type, sessionId: searchParams.get("sessionId") };
  } catch {
    return { role: "other", sessionId: null };
  }
};

const keep = (list: Entry[], entry: Entry, limit: number) => {
  list.push(entry);
  if (list.length > limit) list.splice(0, list.length - limit);
};

/**
 * Rolling events until the first unexplained terminal one, whose window is then frozen while
 * later events roll in a separate tail, so cleanup cannot push it out.
 */
export class LifecycleRecorder {
  readonly #now: () => number;
  readonly #start: number;
  #seq = 0;
  readonly #ring: Entry[] = [];
  readonly #tail: Entry[] = [];
  #frozen: Entry[] | null = null;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#start = now();
  }

  /** Records the event; true only when it is the first unexplained one. */
  record(event: LifecycleEvent, disposition: Disposition): boolean {
    const entry: Entry = {
      ...event,
      seq: ++this.#seq,
      ms: Math.round(this.#now() - this.#start),
      disposition,
    };
    if (this.#frozen) {
      keep(this.#tail, entry, TAIL_EVENTS);
      return false;
    }
    keep(this.#ring, entry, RING_EVENTS);
    if (disposition !== "unexplained") return false;
    this.#frozen = [...this.#ring];
    return true;
  }

  snapshot(reason: "first-unexplained" | "shutdown"): string {
    const report = {
      version: 1,
      reason,
      recorded: this.#seq,
      firstUnexplained: this.#frozen === null ? null : [...this.#frozen],
      events: [...(this.#frozen ? this.#tail : this.#ring)],
    };
    let json = JSON.stringify(report);
    while (json.length > MAX_REPORT_BYTES) {
      // The frozen window's end is the terminal event itself; trim its oldest context last.
      if (report.events.length > 0) report.events.shift();
      else report.firstUnexplained?.shift();
      json = JSON.stringify(report);
    }
    return json;
  }
}

const quietly = (body: () => void) => {
  try {
    body();
  } catch {
    // Diagnostics never change what the provider, page or socket does.
  }
};

type HttpServer = NonNullable<TestProject["vite"]["httpServer"]>;
interface ServerObserver {
  users: number;
  closing: boolean;
  readonly dispose: () => void;
}

const recorder = new LifecycleRecorder();
const sessionOrdinals = new Map<string, number>();
const sessionOwners = new Map<number, DiagnosticProvider>();
const observers = new Map<HttpServer, ServerObserver>();
let providers = 0;
let reportFailed = false;

const sessionOrdinal = (sessionId: string) => {
  let ordinal = sessionOrdinals.get(sessionId);
  if (ordinal === undefined) sessionOrdinals.set(sessionId, (ordinal = sessionOrdinals.size + 1));
  return ordinal;
};

const writeReport = (reason: "first-unexplained" | "shutdown") => {
  const path = process.env.SCIENT_BROWSER_LIFECYCLE_REPORT;
  if (!path) return;
  try {
    NodeFS.writeFileSync(path, recorder.snapshot(reason));
  } catch {
    if (!reportFailed) console.warn("Browser lifecycle diagnostics could not be written.");
    reportFailed = true;
  }
};

const note = (event: LifecycleEvent, disposition: Disposition) => {
  if (recorder.record(event, disposition)) writeReport("first-unexplained");
};

const terminal = (expected: boolean): Disposition => (expected ? "expected" : "unexplained");

const observeServer = (server: HttpServer): ServerObserver => {
  const known = observers.get(server);
  if (known) {
    known.users += 1;
    return known;
  }
  let sockets = 0;
  const onUpgrade = (request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) =>
    quietly(() => {
      const { role, sessionId } = upgradeRole(request.url);
      const session = sessionId === null ? null : sessionOrdinal(sessionId);
      const id = ++sockets;
      recorder.record({ kind: "socket-open", role, socket: id, session }, "routine");
      socket.on(NodeEvents.errorMonitor, (error: unknown) =>
        quietly(() =>
          recorder.record(
            { kind: "socket-error", role, socket: id, error: errorLabel(error) },
            "routine",
          ),
        ),
      );
      socket.once("close", (hadError: boolean) =>
        quietly(() => {
          const owner = session === null ? undefined : sessionOwners.get(session);
          const expected = observer.closing || owner?.expects(session!) === true;
          note(
            { kind: "socket-close", role, socket: id, session, hadError: hadError === true },
            role === "orchestrator" ? terminal(expected) : "routine",
          );
        }),
      );
    });
  const onClose = () =>
    quietly(() => {
      observer.closing = true;
      const expected = [...sessionOwners.values()].some((owner) => owner.shuttingDown());
      note({ kind: "server-close" }, terminal(expected));
    });
  const onError = (error: unknown) =>
    quietly(() => recorder.record({ kind: "server-error", error: errorLabel(error) }, "routine"));
  const emitter: NodeEvents.EventEmitter = server;
  emitter.on("upgrade", onUpgrade);
  emitter.on("close", onClose);
  emitter.on(NodeEvents.errorMonitor, onError);
  const observer: ServerObserver = {
    users: 1,
    closing: false,
    dispose: () => {
      emitter.off("upgrade", onUpgrade);
      emitter.off("close", onClose);
      emitter.off(NodeEvents.errorMonitor, onError);
      observers.delete(server);
    },
  };
  observers.set(server, observer);
  return observer;
};

type Page = ReturnType<PlaywrightBrowserProvider["getPage"]>;

/** The Playwright provider, observed through its public lifecycle only. */
class DiagnosticProvider extends PlaywrightBrowserProvider {
  #observer: ServerObserver | null = null;
  readonly #replacing = new Set<number>();
  readonly #disposers: Array<() => void> = [];
  #watchedBrowser: PlaywrightBrowserProvider["browser"] = null;
  #shuttingDown = false;

  constructor(project: TestProject, options: PlaywrightProviderOptions) {
    super(project, options);
    providers += 1;
    quietly(() => {
      const server = project.vite.httpServer;
      if (server) this.#observer = observeServer(server);
    });
    if (this.#observer === null) recorder.record({ kind: "server-unavailable" }, "routine");
  }

  shuttingDown() {
    return this.#shuttingDown;
  }

  expects(session: number) {
    return this.#shuttingDown || this.#replacing.has(session) || this.#observer?.closing === true;
  }

  override async openPage(sessionId: string, url: string, options: { parallel: boolean }) {
    let session = 0;
    quietly(() => {
      session = sessionOrdinal(sessionId);
      sessionOwners.set(session, this);
      const replacing = this.pages.has(sessionId);
      if (replacing) this.#replacing.add(session);
      recorder.record({ kind: "open-start", session, replacing }, "routine");
    });
    try {
      await super.openPage(sessionId, url, options);
    } catch (error) {
      quietly(() =>
        note(
          { kind: "open-rejected", session, error: errorLabel(error) },
          terminal(this.#shuttingDown),
        ),
      );
      throw error;
    } finally {
      this.#replacing.delete(session);
    }
    quietly(() => {
      recorder.record({ kind: "open-end", session }, "routine");
      const page = this.pages.get(sessionId);
      if (page) this.#watchPage(page, session, url);
      else recorder.record({ kind: "page-missing", session }, "routine");
      this.#watchBrowser();
    });
  }

  #watchPage(page: Page, session: number, opened: string) {
    let category: NavigationCategory | null = null;
    const onClose = () =>
      quietly(() => note({ kind: "page-close", session }, terminal(this.expects(session))));
    // Record only: the provider's own crash handler fails the session.
    const onCrash = () =>
      quietly(() => note({ kind: "page-crash", session }, terminal(this.expects(session))));
    const onNavigated = (frame: ReturnType<Page["mainFrame"]>) =>
      quietly(() => {
        if (frame !== page.mainFrame()) return;
        const next = navigationCategory(frame.url(), opened);
        if (next === category) return;
        category = next;
        recorder.record({ kind: "navigation", session, category: next }, "routine");
      });
    page.on("close", onClose);
    page.on("crash", onCrash);
    page.on("framenavigated", onNavigated);
    this.#disposers.push(() => {
      page.off("close", onClose);
      page.off("crash", onCrash);
      page.off("framenavigated", onNavigated);
    });
  }

  #watchBrowser() {
    const browser = this.browser;
    if (browser === null || browser === this.#watchedBrowser) return;
    this.#watchedBrowser = browser;
    const onDisconnected = () =>
      quietly(() =>
        note(
          { kind: "browser-disconnected" },
          terminal(this.#shuttingDown || this.#observer?.closing === true),
        ),
      );
    browser.on("disconnected", onDisconnected);
    this.#disposers.push(() => browser.off("disconnected", onDisconnected));
  }

  override async close(options?: Parameters<PlaywrightBrowserProvider["close"]>[0]) {
    this.#shuttingDown = true;
    quietly(() => recorder.record({ kind: "provider-close" }, "routine"));
    try {
      return await super.close(options);
    } finally {
      quietly(() => {
        for (const dispose of this.#disposers.splice(0)) quietly(dispose);
        const observer = this.#observer;
        if (observer && --observer.users === 0) observer.dispose();
        if (--providers === 0) writeReport("shutdown");
      });
    }
  }
}

/**
 * Vitest's Playwright provider; with SCIENT_BROWSER_LIFECYCLE_DIAGNOSTICS=1 it also records
 * page, browser and browser-API socket lifecycle to SCIENT_BROWSER_LIFECYCLE_REPORT.
 */
export const browserProvider = (options: PlaywrightProviderOptions = {}) => {
  const option = playwright(options);
  if (process.env.SCIENT_BROWSER_LIFECYCLE_DIAGNOSTICS !== "1") return option;
  return {
    ...option,
    providerFactory: (project: TestProject) => new DiagnosticProvider(project, options),
  };
};

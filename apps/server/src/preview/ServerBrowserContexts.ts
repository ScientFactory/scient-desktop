// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Owns Playwright resources and their idle timer outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";
// SCIENT-FORK:START — Scient Accounts: cookie copies hold a profile's context.
import { ProfileContextLeases } from "../scient/accounts/profileContextLeases.ts";
import { keepServerSessionCookies } from "../scient/accounts/keepServerSessionCookies.ts";
// SCIENT-FORK:END

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

const BADGE_STUB = `if (typeof WorkerNavigator === "function") for (const name of ["setAppBadge", "clearAppBadge"]) WorkerNavigator.prototype[name] = () => Promise.resolve();`;

interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
  createChildSession(...args: ReadonlyArray<unknown>): CdpSession;
}

// The headless shell binds no BadgeService for service workers and kills the renderer of a
// worker that calls navigator.setAppBadge. Playwright resumes each worker itself, so the stub
// can only go in ahead of that resume through its in-process session; without it nothing is stubbed.
const stubWorkerBadges = (client: Browser | BrowserContext) => {
  const { _connection: connection } = client as unknown as {
    readonly _connection?: {
      readonly toImpl?: (
        client: unknown,
      ) =>
        | { readonly _session?: CdpSession; readonly _browser?: { readonly _session?: CdpSession } }
        | undefined;
    };
  };
  const impl = connection?.toImpl?.(client);
  const root = impl?._browser?._session ?? impl?._session;
  if (!root) return;
  const createChildSession = root.createChildSession.bind(root);
  root.createChildSession = (...args) => {
    const session = createChildSession(...args);
    const send = session.send.bind(session);
    session.send = (method, params) => {
      if (method === "Runtime.runIfWaitingForDebugger") {
        void send("Runtime.evaluate", { expression: BADGE_STUB }).catch(constVoid);
      }
      return send(method, params);
    };
    return session;
  };
};

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  /** Names Chrome in the browser's own user agent, which is all a service worker ever sends. */
  readonly chrome: { readonly version: string; readonly platform: NodeJS.Platform };
  /** Closes the shared browser once it has held no context for this long. */
  readonly idleBrowserMs?: number;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

// Chrome froze its user agent apart from the major version.
const UA_SYSTEMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  linux: "X11; Linux x86_64",
  win32: "Windows NT 10.0; Win64; x64",
};

const chromeToken = (major: string) => `Chrome/${major}.0.0.0`;

const chromeUserAgent = (chrome: Options["chrome"]) => {
  const major = /^\d+/.exec(chrome.version)?.[0];
  const system = UA_SYSTEMS[chrome.platform];
  return major && system
    ? `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) ${chromeToken(major)} Safari/537.36`
    : null;
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  browser: { readonly product: string; readonly userAgent: string },
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  // A launch that already named Chrome in the user agent still reports the headless product.
  const version = /^(?:Headless)?Chrome\/((\d+)[\d.]*)/.exec(browser.product);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: browser.userAgent.replace(/HeadlessChrome\/[\d.]+/, chromeToken(major)),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const browser = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(browser, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  // SCIENT-FORK:START — Scient Accounts: cookie copies hold a profile's context.
  readonly leases = new ProfileContextLeases({
    contexts: this.contexts,
    contextFor: (profileId) => this.contextFor(profileId),
  });
  // SCIENT-FORK:END
  // SCIENT-FORK:START — Scient Accounts: Clear moves a profile to a new folder (generation).
  private readonly generations = new Map<string, number>();
  // SCIENT-FORK:END
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSharedContexts = 0;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    // A page's override never reaches its workers, so the browser itself must name Chrome.
    const userAgent = chromeUserAgent(this.options.chrome);
    return {
      executable,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
        ...(userAgent ? [`--user-agent=${userAgent}`] : []),
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ executable, ...options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(executable, (executablePath) =>
          chromium.launch({ ...options, executablePath }),
        );
        stubWorkerBadges(browser);
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  private async sharedContext(options?: Parameters<Browser["newContext"]>[0]) {
    clearTimeout(this.idleTimer);
    this.pendingSharedContexts++;
    const launched = this.sharedBrowser();
    try {
      const context = await (await launched).newContext(options);
      context.on("close", () => this.retireWhenIdle(launched));
      return context;
    } finally {
      this.pendingSharedContexts--;
      this.retireWhenIdle(launched);
    }
  }

  private retireWhenIdle(launched: Promise<Browser>) {
    const delay = this.options.idleBrowserMs;
    if (delay === undefined || this.closing || this.pendingSharedContexts > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.retire(launched), delay);
    this.idleTimer.unref();
  }

  private async retire(launched: Promise<Browser>) {
    const browser = await launched.catch(() => undefined);
    if (!browser || this.browser !== launched || this.pendingSharedContexts > 0) return;
    if (browser.contexts().length > 0) return;
    // Cleared first, so a request during the close launches a fresh browser.
    this.browser = undefined;
    await browser.close().catch(constVoid);
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    // SCIENT-FORK:START — Scient Accounts: a quarantined profile opens again after a restart.
    if (isolationKey === undefined && this.held.has(profileId))
      return Promise.reject(new Error("This profile is unavailable until the server restarts."));
    // SCIENT-FORK:END
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    // SCIENT-FORK:START — Scient Accounts: a tab waits for a cookie copy into its profile.
    const held = this.leases.tabWaits(key, () => this.contextFor(profileId, isolationKey));
    if (held) return held;
    // SCIENT-FORK:END
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      return this.sharedContext(contextOptions);
    }
    // SCIENT-FORK:START — Scient Accounts: the jar's generation is the one it was opened in.
    const generation = this.generations.get(profileId) ?? 0;
    this.contextGenerations.set(profileId, generation);
    const directory = this.profileDirectory(profileId, generation);
    // SCIENT-FORK:END
    await NodeFSP.mkdir(directory, { recursive: true });
    // SCIENT-FORK:START — Scient Accounts: a profile's jar is private to the server's user (POSIX).
    await NodeFSP.chmod(directory, 0o700);
    // SCIENT-FORK:END
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    const context = await this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(directory, {
        ...options,
        ...contextOptions,
        executablePath,
      }),
    );
    // SCIENT-FORK:START — Scient Accounts: the profile a page in this context belongs to (6o).
    this.profileContexts.set(context, profileId);
    // SCIENT-FORK:END
    stubWorkerBadges(context);
    // SCIENT-FORK:START — Scient Accounts: a profile's sign-ins survive a server restart.
    // Nothing is kept while a copy holds the profile, or once it is quarantined (round 6m).
    keepServerSessionCookies(
      context,
      () => this.leases.holds(JSON.stringify([profileId, null])) || this.held.has(profileId),
    );
    // SCIENT-FORK:END
    return context;
  }

  // SCIENT-FORK:START — Scient Accounts: the fence on a profile whose browser hung (6l-6p).
  /** Each profile's own persistent context: the profile a page or popup in it belongs to. */
  private readonly profileContexts = new WeakMap<BrowserContext, string>();
  profileOf(context: BrowserContext) {
    return this.profileContexts.get(context);
  }

  // SCIENT-FORK:END
  // SCIENT-FORK:START — Scient Accounts: one folder per generation; the first keeps its old name.
  private profileDirectory(profileId: string, generation = this.generations.get(profileId) ?? 0) {
    const encoded = encodeURIComponent(profileId);
    const base = NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
    // "%7E" never appears in an encoded id ("~" stays as it is, "%" becomes "%25"): no profile
    // id names another's generation.
    return generation === 0 ? base : `${base}%7Eg${generation}`;
  }

  /**
   * Profiles whose browser never confirmed it closed: fenced in memory for the life of this
   * server (amendment 62). Nothing is carried over a restart, and Playwright ends the browsers it
   * launched when the server exits.
   */
  private readonly held = new Set<string>();
  /** Fences the profile: no new context, lease, write, Clear, purge, page or publication. */
  quarantineProfile(profileId: string) {
    this.contexts.delete(JSON.stringify([profileId, null]));
    this.held.add(profileId);
  }
  /** The profiles fenced until this server starts again. */
  quarantinedProfiles(): ReadonlyArray<string> {
    return [...this.held];
  }
  isQuarantined(profileId: string) {
    return this.held.has(profileId);
  }
  /** Work admitted before a hold checks again where it would touch the folder (round 6n). */
  private refuseHeld(profileId: string) {
    if (this.held.has(profileId))
      throw new Error("This profile is unavailable until the server restarts.");
  }

  /** The generation each profile's open context was opened in: its jar's (round 6e). */
  private readonly contextGenerations = new Map<string, number>();
  /** The generation the profile's jar is in now: the open context's, else its current one. */
  contextGeneration(profileId: string) {
    return (
      (this.contexts.has(JSON.stringify([profileId, null]))
        ? this.contextGenerations.get(profileId)
        : undefined) ??
      this.generations.get(profileId) ??
      0
    );
  }

  /** Which generation each profile is in; a profile not named is in its first. */
  setGenerations(generations: ReadonlyMap<string, number>) {
    this.generations.clear();
    for (const [profileId, generation] of generations) this.generations.set(profileId, generation);
  }

  /** Closes the profile's open context, so its next tab opens in its current generation. */
  async closeProfile(profileId: string) {
    const key = JSON.stringify([profileId, null]);
    // SCIENT-FORK:START — Scient Accounts: a fenced profile's Clear is never done (round 6q).
    this.refuseHeld(profileId);
    // SCIENT-FORK:END
    if (this.leases.holds(key)) await this.leases.cleared(key);
    // SCIENT-FORK:START — Scient Accounts: fenced while it waited, its context dropped (round 6r).
    this.refuseHeld(profileId);
    // SCIENT-FORK:END
    const pending = this.contexts.get(key);
    if (!pending) return;
    this.contexts.delete(key);
    const context = await pending.catch(() => undefined);
    await context?.close();
  }

  /** Deletes one generation's folder, or every generation's (a removed profile's). */
  async purgeProfile(profileId: string, generation?: number) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    // Its browser may still write there: tried again once the server has restarted (6m).
    this.refuseHeld(profileId);
    if (generation !== undefined) {
      if (generation === (this.generations.get(profileId) ?? 0)) await this.closeProfile(profileId);
      this.refuseHeld(profileId);
      await NodeFSP.rm(this.profileDirectory(profileId, generation), {
        recursive: true,
        force: true,
      });
      return;
    }
    await this.closeProfile(profileId);
    const base = NodePath.basename(this.profileDirectory(profileId, 0));
    const names = await NodeFSP.readdir(this.options.profilesDir).catch(() => []);
    for (const name of names)
      if (name === base || name.startsWith(`${base}%7Eg`)) {
        this.refuseHeld(profileId);
        await NodeFSP.rm(NodePath.join(this.options.profilesDir, name), {
          recursive: true,
          force: true,
        });
      }
  }
  // SCIENT-FORK:END

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await this.sharedContext();
    try {
      const page = await context.newPage();
      page.once("close", () => void context.close().catch(constVoid));
      return page;
    } catch (cause) {
      await context.close().catch(constVoid);
      throw cause;
    }
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    // Only a same-machine desktop backend gets the browser channel, so uploads can pass file paths.
    const browser = await chromium.connectOverCDP(endpoint, { isLocal: true, timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    // SCIENT-FORK:START — Scient Accounts: a quarantined profile's folder waits for a restart.
    this.refuseHeld(profileId);
    // SCIENT-FORK:END
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing) return existing;
    const clearing = (async () => {
      // SCIENT-FORK:START — Scient Accounts: a clear waits for a cookie copy into the profile.
      if (this.leases.holds(key)) await this.leases.cleared(key);
      // SCIENT-FORK:END
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      this.refuseHeld(profileId);
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    clearTimeout(this.idleTimer);
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}

// Google's sign-in in a real Electron <webview> tab with the production recovery module: pages
// load, only the refusal is explained. accounts.google.com resolves to a local HTTPS stand-in and
// every other host but localhost fails to resolve, so nothing reaches Google or a user profile.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const STATE_ENV = "SCIENT_GOOGLE_SIGN_IN_SMOKE_STATE";
const GOOGLE_PORT_ENV = "SCIENT_GOOGLE_SIGN_IN_SMOKE_GOOGLE_PORT";
const STEP_TIMEOUT_MS = 20_000;
// The repository's localhost test certificate, also used by the server's peer tests.
const FIXTURES = NodeURL.fileURLToPath(new URL("../../server/src/peer/fixtures/", import.meta.url));

/** A free local port, chosen by the parent so the child can map Google to it before it starts. */
async function freePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

if (!process.versions.electron) {
  const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-google-sign-in-"));
  const googlePort = await freePort();
  const environment = { ...process.env, [STATE_ENV]: state, [GOOGLE_PORT_ENV]: String(googlePort) };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Use the dependency runtime, never the Scient launcher or a user's app. GitHub's Linux runner
  // does not support Electron's OS sandbox; the flag is limited to this disposable process.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone regression harness has no Effect runtime.
  const args = NodeOS.platform() === "linux" && process.env.CI ? ["--no-sandbox"] : [];
  let result;
  try {
    result = NodeChildProcess.spawnSync(
      require("electron"),
      [...args, NodeURL.fileURLToPath(import.meta.url)],
      { env: environment, stdio: "inherit", timeout: 180_000, killSignal: "SIGTERM" },
    );
  } finally {
    NodeFS.rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, session: electronSession } = require("electron");
const googlePort = Number(process.env[GOOGLE_PORT_ENV]);
NodeAssert.ok(googlePort > 0, `Missing ${GOOGLE_PORT_ENV}`);
// Switches must be set before the app is ready.
app.commandLine.appendSwitch(
  "host-resolver-rules",
  `MAP accounts.google.com 127.0.0.1:${googlePort}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
);
app.commandLine.appendSwitch("no-proxy-server");

async function withTimeout(promise, describeStep) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${describeStep}`)), STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Loads `url` and answers with its main-frame failure code and the page it ended on, or code 0
 * once a page finished loading after Google's redirects. Events of the previous load arrive before
 * this navigation starts.
 */
async function load(contents, url) {
  const { promise, resolve } = Promise.withResolvers();
  let started = false;
  const start = (details) => {
    if (details.isMainFrame && !details.isSameDocument) started = true;
  };
  const failed = (_event, code, _description, failedUrl, isMainFrame) => {
    if (started && isMainFrame && code !== -3) done({ code, url: failedUrl });
  };
  const finished = () => {
    if (started) done({ code: 0, url: contents.getURL() });
  };
  const done = (outcome) => {
    contents.off("did-start-navigation", start);
    contents.off("did-fail-load", failed);
    contents.off("did-finish-load", finished);
    resolve(outcome);
  };
  contents.on("did-start-navigation", start);
  contents.on("did-fail-load", failed);
  contents.on("did-finish-load", finished);
  contents.loadURL(url).catch(() => undefined);
  return withTimeout(promise, `loading ${url}`);
}

async function run() {
  const state = process.env[STATE_ENV];
  NodeAssert.ok(state, `Missing ${STATE_ENV}`);
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  await app.whenReady();

  const { followTabSignIn, watchSignInPopup } =
    await import("../src/scient/browser/googleSignInRecovery.ts");

  const tls = {
    key: NodeFS.readFileSync(NodePath.join(FIXTURES, "localhost-key.pem")),
    cert: NodeFS.readFileSync(NodePath.join(FIXTURES, "localhost-cert.pem")),
  };

  // Google's stand-in. Every page it serves runs a script that reports back, so a page that loaded
  // and ran is told from one that was stopped.
  const ran = [];
  const ranWaiters = new Map();
  const nextRun = (path) => {
    const { promise, resolve } = Promise.withResolvers();
    ranWaiters.set(path, [...(ranWaiters.get(path) ?? []), resolve]);
    return withTimeout(promise, `Google's ${path} page to load and run`);
  };
  const google = NodeHttps.createServer(tls, (request, response) => {
    const { pathname, searchParams } = new URL(request.url, "https://accounts.google.com");
    if (pathname.startsWith("/o/oauth2/")) {
      // As Google does without a session: on to the credential pages.
      response.writeHead(302, { location: "https://accounts.google.com/v3/signin/identifier" });
      response.end();
      return;
    }
    if (pathname === "/ran") {
      const page = searchParams.get("page");
      ran.push(page);
      for (const resolve of ranWaiters.get(page) ?? []) resolve();
      ranWaiters.delete(page);
      response.writeHead(204);
      response.end();
      return;
    }
    // `?refuse` refuses without a new page load, as Google's sign-in pages sometimes do.
    const refuse = searchParams.has("refuse")
      ? `history.pushState(null, "", "/v3/signin/rejected");`
      : "";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>Google</title><script>fetch("/ran?page=" + encodeURIComponent(location.pathname));${refuse}</script>`,
    );
  });
  await new Promise((resolve) => google.listen(googlePort, "127.0.0.1", resolve));

  // Another site, served over https so it can be where a sign-in starts again.
  const site = NodeHttps.createServer(tls, (request, response) => {
    const { pathname, searchParams } = new URL(request.url, "https://localhost");
    if (pathname === "/redirect") {
      response.writeHead(302, { location: searchParams.get("to") });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    const frame = searchParams.get("frame");
    response.end(
      `<!doctype html><title>Site</title><p>Site</p>${
        frame ? `<iframe src="${frame.replaceAll('"', "&quot;")}"></iframe>` : ""
      }`,
    );
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const siteOrigin = `https://localhost:${site.address().port}`;
  const siteRestart = `${siteOrigin}/`;

  const PARTITION = "scient-google-sign-in-smoke";
  electronSession
    .fromPartition(PARTITION)
    .setCertificateVerifyProc(({ hostname }, callback) =>
      callback(hostname === "accounts.google.com" || hostname === "localhost" ? 0 : -2),
    );

  // The tab: a <webview> guest in an app window, as Scient's browser panel hosts its tabs.
  const host = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, webviewTag: true },
  });
  const attached = new Promise((resolve) =>
    host.webContents.once("did-attach-webview", (_event, guest) => resolve(guest)),
  );
  await host.loadURL(
    `data:text/html,${encodeURIComponent(
      `<!doctype html><webview partition="${PARTITION}" allowpopups src="about:blank" style="width:800px;height:600px"></webview>`,
    )}`,
  );
  const tab = await withTimeout(attached, "the <webview> tab to attach");
  NodeAssert.equal(tab.getType(), "webview");

  const reports = [];
  let reportWaiter = null;
  const report = (event) => {
    reports.push(event);
    reportWaiter?.(event);
    reportWaiter = null;
  };
  const nextReport = () =>
    withTimeout(
      new Promise((resolve) => {
        reportWaiter = resolve;
      }),
      "Google's refusal to be reported",
    );
  const signIn = followTabSignIn(tab, report);

  tab.setWindowOpenHandler(() => ({ action: "allow" }));
  let popupCreated = null;
  tab.on("did-create-window", (popup) => {
    // Watched as it opens, as the Manager does, so nothing it does is missed.
    const reported = new Promise((resolve) => watchSignInPopup(popup, tab, resolve));
    popupCreated?.({ popup, reported });
    popupCreated = null;
  });

  const IDENTIFIER = "https://accounts.google.com/v3/signin/identifier";
  const CHOOSER = "https://accounts.google.com/v3/signin/accountchooser";
  const PASSWORD = "https://accounts.google.com/v3/signin/challenge/pwd";
  const REJECTED = "https://accounts.google.com/v3/signin/rejected";
  const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth?client_id=smoke";

  /** Loads one of Google's sign-in pages in the tab and checks it loaded and ran. */
  const loadsAndRuns = async (url) => {
    const path = new URL(url).pathname;
    const pageRan = nextRun(path);
    const outcome = await load(tab, url);
    NodeAssert.equal(outcome.code, 0, `${path} didn't load`);
    await pageRan;
    return outcome;
  };

  let phase = "Google's sign-in pages in a tab, which load for Google to decide";
  try {
    for (const url of [IDENTIFIER, CHOOSER, PASSWORD]) await loadsAndRuns(url);

    phase = "a site sending the tab to Continue with Google, which Google lets through";
    NodeAssert.equal((await load(tab, siteRestart)).code, 0);
    const identifierRan = nextRun("/v3/signin/identifier");
    const redirected = await load(tab, `${siteOrigin}/redirect?to=${encodeURIComponent(OAUTH)}`);
    NodeAssert.deepEqual(redirected, { code: 0, url: IDENTIFIER });
    await identifierRan;
    NodeAssert.deepEqual(reports, [], "a sign-in page Google didn't refuse was reported");

    phase = "Google refusing that site's Continue with Google";
    let reported = nextReport();
    await loadsAndRuns(REJECTED);
    NodeAssert.deepEqual(await reported, {
      page: "rejected",
      context: "tab",
      restartUrl: siteRestart,
      pageUrl: REJECTED,
    });

    phase = "Google refusing its own sign-in without a page load";
    NodeAssert.equal((await load(tab, siteRestart)).code, 0);
    reported = nextReport();
    await loadsAndRuns(`${IDENTIFIER}?refuse`);
    NodeAssert.deepEqual(await reported, {
      page: "rejected",
      context: "tab",
      restartUrl: null,
      pageUrl: REJECTED,
    });

    phase = "Google refusing a frame's sign-in";
    const framePage = `${siteOrigin}/?frame=${encodeURIComponent(REJECTED)}`;
    reported = nextReport();
    NodeAssert.equal((await load(tab, framePage)).code, 0);
    NodeAssert.deepEqual(await reported, {
      page: "rejected",
      context: "frame",
      restartUrl: siteRestart,
      pageUrl: framePage,
    });

    phase = "a popup's Continue with Google, which stays open until Google refuses";
    NodeAssert.equal((await load(tab, siteRestart)).code, 0);
    const created = new Promise((resolve) => {
      popupCreated = resolve;
    });
    await tab.executeJavaScript(
      `window.open(${JSON.stringify(OAUTH)}, "_blank", "popup"); 0`,
      true,
    );
    const { popup, reported: popupReported } = await withTimeout(created, "a popup to open");
    const popupContents = popup.webContents;
    if (popupContents.getURL() !== IDENTIFIER) {
      await withTimeout(
        new Promise((resolve) => {
          const finished = () => {
            if (popupContents.getURL() !== IDENTIFIER) return;
            popupContents.off("did-finish-load", finished);
            resolve();
          };
          popupContents.on("did-finish-load", finished);
        }),
        "the popup to reach Google's sign-in",
      );
    }
    NodeAssert.equal(popup.isDestroyed(), false, "a popup Google didn't refuse was closed");
    void popupContents.loadURL(REJECTED).catch(() => undefined);
    NodeAssert.deepEqual(await withTimeout(popupReported, "the popup's refusal"), {
      page: "rejected",
      context: "popup",
      restartUrl: siteRestart,
      pageUrl: siteRestart,
    });
    await withTimeout(
      new Promise((resolve) => (popup.isDestroyed() ? resolve() : popup.once("closed", resolve))),
      "the refused popup to close",
    );

    phase = "Google's session upkeep, never reported";
    const before = reports.length;
    NodeAssert.equal((await load(tab, "https://accounts.google.com/ListAccounts?gpsia=1")).code, 0);
    NodeAssert.equal(reports.length, before);
    console.log("[scient-google-sign-in-smoke] passed");
  } catch (error) {
    throw new Error(`Failed during ${phase}`, { cause: error });
  } finally {
    signIn.dispose();
    host.destroy();
    google.close();
    site.close();
  }
}

void run().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);

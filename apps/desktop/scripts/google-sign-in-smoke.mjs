// Google's sign-in pages stopped in real Electron, with the production guard and recovery modules.
// Nothing reaches Google: accounts.google.com resolves to a local HTTPS stand-in, every other host
// but localhost fails to resolve, and the stand-in's test certificate is trusted only by this
// process's own sessions. No user data, profile or account is touched.
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
 * Loads `url` and answers with its main-frame failure code, or 0 once it finished there. Events of
 * the previous load (an error page finishing late) arrive before this navigation starts.
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
    if (started && contents.getURL() === url) done({ code: 0, url });
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

/** The next frame (not the page itself) that fails to load in `contents`. */
function nextFrameFailure(contents) {
  const { promise, resolve } = Promise.withResolvers();
  const failed = (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame || code === -3) return;
    contents.off("did-fail-load", failed);
    resolve({ code, url });
  };
  contents.on("did-fail-load", failed);
  return withTimeout(promise, "a frame to fail");
}

async function run() {
  const state = process.env[STATE_ENV];
  NodeAssert.ok(state, `Missing ${STATE_ENV}`);
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  await app.whenReady();

  const { guardGoogleSignIn, BLOCKED_BY_CLIENT } =
    await import("../src/scient/browser/googleSignInGuard.ts");
  const { followTabSignIn, watchSignInPopup } =
    await import("../src/scient/browser/googleSignInRecovery.ts");

  const tls = {
    key: NodeFS.readFileSync(NodePath.join(FIXTURES, "localhost-key.pem")),
    cert: NodeFS.readFileSync(NodePath.join(FIXTURES, "localhost-cert.pem")),
  };

  // Google's stand-in. Each arrival is a request that would have reached Google; every page it
  // serves runs a script that reports back, so a page that ran is told from one that was stopped.
  const arrivals = [];
  const waiters = new Map();
  const arrived = (path) => arrivals.filter((arrival) => arrival === path).length;
  const nextArrival = (path) => {
    const { promise, resolve } = Promise.withResolvers();
    waiters.set(path, [...(waiters.get(path) ?? []), resolve]);
    return withTimeout(promise, `a request for ${path} to reach Google's stand-in`);
  };
  const google = NodeHttps.createServer(tls, (request, response) => {
    const { pathname } = new URL(request.url, "https://accounts.google.com");
    arrivals.push(pathname);
    for (const resolve of waiters.get(pathname) ?? []) resolve();
    waiters.delete(pathname);
    if (pathname.startsWith("/o/oauth2/")) {
      // As Google does when its session is gone: on to the credential pages.
      response.writeHead(302, { location: "https://accounts.google.com/v3/signin/identifier" });
      response.end();
      return;
    }
    if (pathname === "/ran") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Google</title><script>fetch("/ran")</script>`);
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

  const trustFixtures = (partition) => {
    const browserSession = electronSession.fromPartition(partition);
    browserSession.setCertificateVerifyProc(({ hostname }, callback) =>
      callback(hostname === "accounts.google.com" || hostname === "localhost" ? 0 : -2),
    );
    return browserSession;
  };
  const windowIn = (browserSession) =>
    new BrowserWindow({
      show: false,
      webPreferences: { session: browserSession, contextIsolation: true, sandbox: true },
    });

  const IDENTIFIER = "https://accounts.google.com/v3/signin/identifier";
  const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth?client_id=smoke";
  const unguardedWindow = windowIn(trustFixtures("scient-google-sign-in-smoke-unguarded"));
  const guarded = trustFixtures("scient-google-sign-in-smoke");
  guardGoogleSignIn(guarded);
  const window = windowIn(guarded);
  const tab = window.webContents;
  const signIn = followTabSignIn(tab);
  let popupCreated = null;
  tab.on("did-create-window", (popup) => {
    // Watched as it opens, as the Manager does, so nothing it does is missed.
    const reported = new Promise((resolve) => watchSignInPopup(popup, tab, resolve));
    popupCreated?.({ popup, reported });
    popupCreated = null;
  });
  const nextPopupReport = async (script) => {
    const created = new Promise((resolve) => {
      popupCreated = resolve;
    });
    await tab.executeJavaScript(script, true);
    const { popup, reported } = await withTimeout(created, "a popup to open");
    const report = await withTimeout(reported, "the popup's sign-in to be stopped");
    await withTimeout(
      new Promise((resolve) => (popup.isDestroyed() ? resolve() : popup.once("closed", resolve))),
      "the stopped popup to close",
    );
    return report;
  };

  let phase = "the stand-in, without the guard (control)";
  try {
    // Without the guard the credential page loads and its script runs: what the guard must stop.
    const ran = nextArrival("/ran");
    NodeAssert.equal((await load(unguardedWindow.webContents, IDENTIFIER)).code, 0);
    await ran;
    unguardedWindow.destroy();
    arrivals.length = 0;

    phase = "a tab opening Google's sign-in, with no Google session";
    const credentials = await load(tab, IDENTIFIER);
    NodeAssert.equal(credentials.code, BLOCKED_BY_CLIENT);
    NodeAssert.deepEqual(signIn.blocked(credentials.code, credentials.url), {
      page: "credentials",
      context: "tab",
      restartUrl: null,
      pageUrl: IDENTIFIER,
    });

    phase = "a site redirecting the tab to Continue with Google";
    NodeAssert.equal((await load(tab, `${siteOrigin}/`)).code, 0);
    const redirected = await load(tab, `${siteOrigin}/redirect?to=${encodeURIComponent(OAUTH)}`);
    NodeAssert.equal(redirected.code, BLOCKED_BY_CLIENT);
    NodeAssert.deepEqual(signIn.blocked(redirected.code, redirected.url), {
      page: "transit",
      context: "tab",
      restartUrl: siteRestart,
      pageUrl: OAUTH,
    });

    phase = "a page opening Continue with Google in a popup";
    NodeAssert.equal((await load(tab, `${siteOrigin}/`)).code, 0);
    NodeAssert.deepEqual(
      await nextPopupReport(`window.open(${JSON.stringify(OAUTH)}, "_blank", "popup"); 0`),
      { page: "transit", context: "popup", restartUrl: siteRestart, pageUrl: `${siteOrigin}/` },
    );

    phase = "a blank popup sent to Google's sign-in afterwards";
    NodeAssert.equal(
      (
        await nextPopupReport(
          `window.open("about:blank", "_blank", "popup").location = "https://accounts.google.com/AddSession"; 0`,
        )
      ).page,
      "credentials",
    );

    phase = "a frame sent to Google's sign-in";
    let frameFailed = nextFrameFailure(tab);
    const framePage = `${siteOrigin}/?frame=${encodeURIComponent(IDENTIFIER)}`;
    NodeAssert.equal((await load(tab, framePage)).code, 0);
    let frame = await frameFailed;
    NodeAssert.deepEqual(signIn.blockedFrame(frame.code, frame.url), {
      page: "credentials",
      context: "frame",
      restartUrl: siteRestart,
      pageUrl: framePage,
    });
    NodeAssert.deepEqual(arrivals, [], "a stopped sign-in page reached Google");

    phase = "a frame passing a session on, which Google sends to its sign-in";
    frameFailed = nextFrameFailure(tab);
    const probe = nextArrival("/o/oauth2/v2/auth");
    const probePage = `${siteOrigin}/?frame=${encodeURIComponent(`${OAUTH}&prompt=none`)}`;
    NodeAssert.equal((await load(tab, probePage)).code, 0);
    await probe;
    frame = await frameFailed;
    NodeAssert.equal(signIn.blockedFrame(frame.code, frame.url)?.page, "credentials");
    NodeAssert.equal(arrived("/v3/signin/identifier"), 0, "the frame's sign-in page loaded");

    phase = "Google's session upkeep, which is never stopped";
    const upkeep = await load(tab, "https://accounts.google.com/ListAccounts?gpsia=1");
    NodeAssert.equal(upkeep.code, 0, "session upkeep was stopped");
    NodeAssert.equal(arrived("/ListAccounts"), 1);

    phase = "a profile holding a Google session";
    await guarded.cookies.set({
      url: "https://accounts.google.com/",
      name: "__Secure-1PSID",
      value: "smoke",
      secure: true,
    });
    const chooserRan = nextArrival("/ran");
    const chooser = await load(tab, "https://accounts.google.com/AccountChooser");
    NodeAssert.equal(chooser.code, 0, "a signed-in profile's chooser was stopped");
    await chooserRan;

    phase = "a stale session: Continue with Google goes through, Google asks for credentials";
    NodeAssert.equal((await load(tab, `${siteOrigin}/`)).code, 0);
    const passed = nextArrival("/o/oauth2/v2/auth");
    const stale = await load(tab, OAUTH);
    await passed;
    NodeAssert.equal(stale.code, BLOCKED_BY_CLIENT);
    NodeAssert.deepEqual(signIn.blocked(stale.code, stale.url), {
      page: "credentials",
      context: "tab",
      restartUrl: siteRestart,
      pageUrl: IDENTIFIER,
    });
    const password = await load(tab, "https://accounts.google.com/v3/signin/challenge/pwd");
    NodeAssert.equal(password.code, BLOCKED_BY_CLIENT, "a credential page loaded with a session");
    NodeAssert.equal(
      arrivals.filter((path) => path.startsWith("/v3/signin")).length,
      0,
      "a stopped credential page reached Google",
    );

    phase = "a passkey on another site, which the guard leaves alone";
    NodeAssert.equal((await load(tab, `${siteOrigin}/`)).code, 0);
    tab.debugger.attach("1.3");
    try {
      await tab.debugger.sendCommand("WebAuthn.enable");
      await tab.debugger.sendCommand("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      });
      const ceremony = await withTimeout(
        tab.executeJavaScript(
          `(async () => {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const created = await navigator.credentials.create({ publicKey: {
              challenge, rp: { name: "Smoke", id: "localhost" },
              user: { id: new Uint8Array([1]), name: "smoke", displayName: "Smoke" },
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
              authenticatorSelection: { residentKey: "required", userVerification: "required" },
            } });
            const got = await navigator.credentials.get({ publicKey: {
              challenge, rpId: "localhost", userVerification: "required",
              allowCredentials: [{ type: "public-key", id: created.rawId }],
            } });
            return created.type + " " + got.type;
          })()`,
          true,
        ),
        "a passkey ceremony",
      );
      NodeAssert.equal(ceremony, "public-key public-key");
    } finally {
      tab.debugger.detach();
    }
    console.log("[scient-google-sign-in-smoke] passed");
  } catch (error) {
    throw new Error(`Failed during ${phase}`, { cause: error });
  } finally {
    signIn.dispose();
    if (!unguardedWindow.isDestroyed()) unguardedWindow.destroy();
    window.destroy();
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

#!/usr/bin/env node
// Qualifies Scient's session copy on this platform's Electron, in a dev app; --help prints usage.
const USAGE = `Usage, with a dev app running on a known remote debugging port:

  node apps/desktop/scripts/qualify-session-copy.mjs --port 9372 [--environment <id>]

Runs the dev app's cookie-copy qualification and prints one PASS or FAIL line per case, then
"N passed, M failed"; it exits 0 only when every case passes. Only synthetic .test cookies are
written, into throwaway partitions the app clears afterwards; your profiles are never touched.

With --environment, that connected computer's server runs the shared cases on its own browser
instead, in throwaway profiles it deletes afterwards. It must be a development server (started
with --dev-url or VITE_DEV_SERVER_URL). Needs Node 22 or later.`;
const portFlag = process.argv.indexOf("--port");
const port = Number(portFlag === -1 ? Number.NaN : process.argv[portFlag + 1]);
const environmentFlag = process.argv.indexOf("--environment");
const environmentId = environmentFlag === -1 ? undefined : process.argv[environmentFlag + 1];
if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
if (!Number.isInteger(port) || port <= 0 || (environmentFlag !== -1 && !environmentId)) {
  console.error(USAGE);
  process.exit(2);
}

/** Runs one expression in a page over CDP and returns its value. */
async function evaluate(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect")), { once: true });
  });
  try {
    const answer = new Promise((resolve) =>
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id === 1) resolve(message);
      }),
    );
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
    const message = await answer;
    if (message.error || message.result.exceptionDetails)
      throw new Error(message.error?.message ?? message.result.exceptionDetails.text);
    return message.result.result.value;
  } finally {
    socket.close();
  }
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
  response.json(),
);
const run = environmentId
  ? `window.scientQualifyRemoteSessions(${JSON.stringify(environmentId)})`
  : "window.desktopBridge.accounts.qualifySessionCopy()";
const offered = environmentId
  ? "typeof window.scientQualifyRemoteSessions === 'function'"
  : "typeof window.desktopBridge?.accounts?.qualifySessionCopy === 'function'";
let results;
for (const target of targets) {
  if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
  const available = await evaluate(target.webSocketDebuggerUrl, offered).catch(() => false);
  if (!available) continue;
  results = await evaluate(target.webSocketDebuggerUrl, run);
  break;
}
if (!Array.isArray(results)) {
  console.error(
    results === null
      ? "The app refused the check, or that computer's server is not a development one."
      : "No app window with the qualification found. Is this a dev app on that port?",
  );
  process.exit(1);
}
for (const result of results)
  console.log(
    `${result.ok ? "PASS" : "FAIL"} ${String(result.case).padStart(2)} ${result.name}${
      result.detail ? `: ${result.detail}` : ""
    }`,
  );
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

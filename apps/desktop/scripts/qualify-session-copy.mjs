#!/usr/bin/env node
// Qualifies Scient's session copy on this platform's Electron, in a dev app. USAGE below is the
// full usage and expected output (lint caps comments at four lines); it also prints with --help.
const USAGE = `Usage, with a dev app running and its remote debugging port known:

  node apps/desktop/scripts/qualify-session-copy.mjs --port 9372

It finds the app window through http://127.0.0.1:<port>/json/list, runs
window.desktopBridge.accounts.qualifySessionCopy() there, and prints one line per case:

  PASS  1 isolation
  PASS  2 host-only
  ...
  PASS 12 skip
  PASS 13 navigation first
  PASS 14 partitioned navigation first
  14 passed, 0 failed

A failing case reads, for example:

  FAIL  9 exact delete: deleting one partition's cookie did not leave the other two

It exits 0 when every case passes and 1 otherwise. The app writes only synthetic cookies for
qualify.test into two throwaway partitions (persist:scient-qualify-{a,b}-<uuid>) and clears them
afterwards; the user's profiles are never read or written. Needs Node 22 or later.

With --environment <id>, the same dev app asks that connected computer's server to run cases
1-9 on its own browser, plus "helper page" and "persistence", in two throwaway server-browser
profiles (scient-qualify-{a,b}-<uuid>) it deletes afterwards, failure or not:

  node apps/desktop/scripts/qualify-session-copy.mjs --port 9372 --environment <id>

The remote server must be a development one: started with --dev-url (or VITE_DEV_SERVER_URL).`;
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

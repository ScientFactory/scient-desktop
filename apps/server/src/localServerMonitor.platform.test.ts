// FILE: localServerMonitor.platform.test.ts
// Purpose: Exercises native listener and process-lineage discovery against a real loopback server.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { expect, it } from "vitest";

import { listLocalServers } from "./localServerMonitor";

const SUPPORTED_PLATFORM = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);
const DISCOVERY_ATTEMPTS = 5;
const DISCOVERY_RETRY_MS = 400;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for smoke server port. stderr=${child.stderr.read()}`));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.removeListener("data", onData);
      child.removeListener("exit", onExit);
    };
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
      const port = Number(line);
      if (Number.isInteger(port) && port > 0) {
        cleanup();
        resolve(port);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Smoke server exited before listening (code ${String(code)}).`));
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

it.runIf(SUPPORTED_PLATFORM.has(process.platform))(
  "discovers a real Vite-labelled loopback listener through the native OS path",
  { timeout: 45_000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          "const http = require('node:http');",
          "const server = http.createServer((_request, response) => response.end('ok'));",
          "server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
          "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
        ].join(" "),
        "vite-localhost-smoke",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    try {
      const port = await waitForPort(child);
      let discovered = null;
      let lastSnapshot = await listLocalServers({ includePageTitles: false });
      for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
        discovered = lastSnapshot.servers.find(
          (server) => server.pid === child.pid && server.ports.includes(port),
        );
        if (discovered) break;
        await delay(DISCOVERY_RETRY_MS);
        lastSnapshot = await listLocalServers({ includePageTitles: false });
      }

      expect(
        discovered,
        `Expected pid=${String(child.pid)} port=${String(port)}; found ${JSON.stringify(
          lastSnapshot.servers.map((server) => ({
            pid: server.pid,
            ports: server.ports,
            command: server.command,
            args: server.args,
          })),
        )}`,
      ).toMatchObject({
        pid: child.pid,
        args: expect.stringContaining("vite-localhost-smoke"),
        ports: expect.arrayContaining([port]),
      });
    } finally {
      await stopChild(child);
    }
  },
);

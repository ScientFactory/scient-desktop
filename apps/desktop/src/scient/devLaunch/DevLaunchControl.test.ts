// @effect-diagnostics nodeBuiltinImport:off -- The test plays the controller over a real socket or named pipe.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  readDevLaunchControlConfig,
  startDevLaunchControlServer,
  type DevLaunchControlResponse,
} from "./DevLaunchControl.ts";

function freshAddress(): string {
  const id = NodeCrypto.randomBytes(6).toString("hex");
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The test picks the host's local transport.
  return NodeOS.platform() === "win32"
    ? `\\\\.\\pipe\\scient-dev-launch-test-${id}`
    : NodePath.join(NodeOS.tmpdir(), `scient-dev-launch-test-${id}.sock`);
}

function send(address: string, request: unknown): Promise<DevLaunchControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(address);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => resolve(JSON.parse(data) as DevLaunchControlResponse));
    socket.on("error", reject);
  });
}

describe("DevLaunchControl", () => {
  it("opens only with an address and a full-length launch token", () => {
    const token = "a".repeat(32);
    assert.isNull(readDevLaunchControlConfig({}));
    assert.isNull(
      readDevLaunchControlConfig({
        SCIENT_DEV_LAUNCH_CONTROL: "x",
        SCIENT_DEV_LAUNCH_TOKEN: "short",
      }),
    );
    assert.deepEqual(
      readDevLaunchControlConfig({
        SCIENT_DEV_LAUNCH_CONTROL: "x",
        SCIENT_DEV_LAUNCH_TOKEN: token,
      }),
      { address: "x", token },
    );
  });

  it("answers this launch's controller and nobody else", async () => {
    const token = NodeCrypto.randomBytes(32).toString("hex");
    const address = freshAddress();
    const calls: string[] = [];
    let ready = false;
    const server = await startDevLaunchControlServer({
      config: { address, token },
      isReady: () => ready,
      activate: () => calls.push("activate"),
      quit: () => calls.push("quit"),
    });
    try {
      assert.deepEqual(await send(address, { token: "b".repeat(64), type: "quit" }), {
        ok: false,
        error: "unauthorized",
      });
      assert.deepEqual(await send(address, { token, type: "restart" }), {
        ok: false,
        error: "invalid-request",
      });
      assert.deepEqual(await send(address, { token, type: "status" }), { ok: true, ready: false });
      ready = true;
      assert.deepEqual(await send(address, { token, type: "activate" }), { ok: true, ready: true });
      assert.deepEqual(await send(address, { token, type: "quit" }), { ok: true, ready: true });
      assert.deepEqual(calls, ["activate", "quit"]);
    } finally {
      await server.close();
    }
  });
});

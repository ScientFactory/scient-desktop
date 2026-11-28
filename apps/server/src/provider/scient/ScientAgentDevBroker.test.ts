// @effect-diagnostics nodeBuiltinImport:off - The fixture binds a real Unix socket.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { prepareScientAgentDevBroker } from "./ScientAgentDevBroker.ts";

async function fixture() {
  const tmp = HostProcess.Platform.defaultValue() === "darwin" ? "/private/tmp" : NodeOS.tmpdir();
  const home = await NodeFSP.mkdtemp(NodePath.join(tmp, "sdb-"));
  const broker = NodePath.join(home, ".local", "share", "scient-dev-chatgpt");
  await NodeFSP.mkdir(broker, { recursive: true, mode: 0o700 });
  const token = NodePath.join(broker, "auth-broker.token");
  const consent = NodePath.join(broker, "share-with-dev-apps");
  const socket = NodePath.join(broker, "broker.sock");
  const server = NodeNet.createServer();
  await NodeFSP.writeFile(token, "test-only-bearer", { mode: 0o600 });
  const setup = {
    platform: "darwin",
    desktop: true,
    environment: {
      SCIENT_LOCAL_DEV_APP_MANAGED: "1",
      SCIENT_NEXT_DEVELOPMENT_STATE: "true",
    },
    home,
    userId: (await NodeFSP.stat(broker)).uid,
  } as const;
  return {
    setup,
    socket,
    listen: async () => {
      server.listen(socket);
      await NodeEvents.once(server, "listening");
    },
    consent,
    [Symbol.asyncDispose]: async () => {
      await server[Symbol.asyncDispose]();
      await NodeFSP.rm(home, { recursive: true, force: true });
    },
  };
}

describe("Scient Agent dev broker", () => {
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "shares one broker only with approved managed dev apps",
    async () => {
      await using state = await fixture();
      expect(await prepareScientAgentDevBroker(state.setup)).toBeUndefined();
      await NodeFSP.writeFile(state.consent, "", { mode: 0o600 });
      // Consent alone must not route to a legacy TCP broker or a non-socket path.
      expect(await prepareScientAgentDevBroker(state.setup)).toBeUndefined();
      await NodeFSP.writeFile(state.socket, "", { mode: 0o600 });
      expect(await prepareScientAgentDevBroker(state.setup)).toBeUndefined();
      await NodeFSP.unlink(state.socket);
      await state.listen();
      expect(await prepareScientAgentDevBroker({ ...state.setup, desktop: false })).toBeUndefined();
      for (const environment of [
        {},
        { ...state.setup.environment, SCIENT_NEXT_DEVELOPMENT_STATE: undefined },
        { ...state.setup.environment, SCIENT_DEV_IDENTITY: "off" },
      ]) {
        expect(await prepareScientAgentDevBroker({ ...state.setup, environment })).toBeUndefined();
      }
      expect(await prepareScientAgentDevBroker(state.setup)).toBe(`unix:${state.socket}`);
    },
  );
});

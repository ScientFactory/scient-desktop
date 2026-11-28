import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { describe, expect, it } from "vitest";
import { prepareScientAgentDevBroker } from "./ScientAgentDevBroker.ts";

async function fixture() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-dev-broker-"));
  const broker = NodePath.join(home, ".local", "share", "scient-dev-chatgpt");
  const root = NodePath.join(home, "instance");
  await NodeFSP.mkdir(broker, { recursive: true, mode: 0o700 });
  await NodeFSP.mkdir(root, { mode: 0o700 });
  const token = NodePath.join(broker, "auth-broker.token");
  const consent = NodePath.join(broker, "share-with-dev-apps");
  await NodeFSP.writeFile(token, "test-only-bearer", { mode: 0o600 });
  const setup = {
    platform: "darwin",
    environment: {
      SCIENT_LOCAL_DEV_APP_MANAGED: "1",
      SCIENT_NEXT_DEVELOPMENT_STATE: "true",
    },
    home,
    root,
    userId: (await NodeFSP.stat(broker)).uid,
  } as const;
  return {
    setup,
    token,
    consent,
    target: NodePath.join(root, "auth-broker.token"),
    [Symbol.asyncDispose]: () => NodeFSP.rm(home, { recursive: true, force: true }),
  };
}

describe("Scient Agent dev broker", () => {
  it.skipIf(!symlinksSupported)(
    "shares one broker only with approved managed dev apps",
    async () => {
      await using state = await fixture();
      expect(await prepareScientAgentDevBroker(state.setup)).toBeUndefined();
      await NodeFSP.writeFile(state.consent, "", { mode: 0o600 });
      for (const environment of [
        {},
        { ...state.setup.environment, SCIENT_NEXT_DEVELOPMENT_STATE: undefined },
        { ...state.setup.environment, SCIENT_DEV_IDENTITY: "off" },
      ]) {
        expect(await prepareScientAgentDevBroker({ ...state.setup, environment })).toBeUndefined();
      }
      await expect(NodeFSP.lstat(state.target)).rejects.toMatchObject({ code: "ENOENT" });

      const other = NodePath.join(state.setup.home, "other-instance");
      await NodeFSP.mkdir(other);
      const urls = await Promise.all([
        prepareScientAgentDevBroker(state.setup),
        prepareScientAgentDevBroker({ ...state.setup, root: other }),
      ]);
      expect(urls).toEqual(["http://127.0.0.1:8765", "http://127.0.0.1:8765"]);
      expect(await NodeFSP.readlink(state.target)).toBe(state.token);
      expect(await NodeFSP.readlink(NodePath.join(other, "auth-broker.token"))).toBe(state.token);
      expect(await prepareScientAgentDevBroker(state.setup)).toBe(urls[0]);
    },
  );

  it("does not replace a candidate's independently configured bearer", async () => {
    await using state = await fixture();
    await NodeFSP.writeFile(state.consent, "", { mode: 0o600 });
    await NodeFSP.writeFile(state.target, "candidate-only-bearer", { mode: 0o600 });
    expect(await prepareScientAgentDevBroker(state.setup)).toBeUndefined();
    expect(await NodeFSP.readFile(state.target, "utf8")).toBe("candidate-only-bearer");
  });
});

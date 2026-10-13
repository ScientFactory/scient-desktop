// @effect-diagnostics nodeBuiltinImport:off -- Controlled transport exercises the real private installer without network or credentials.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, expect, it, vi } from "vite-plus/test";

import { hydrateManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import { ManagedScientAgentRuntime } from "./managedScientAgentRuntime.ts";
import { resolveScientAgentArtifactPolicy } from "./scientAgentManifest.ts";

const roots: string[] = [];
const bytes = Buffer.from("synthetic Scient executable");

function artifact(
  version: string,
  digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
) {
  const policy = resolveScientAgentArtifactPolicy({ platform: "darwin", arch: "arm64" })!;
  return hydrateManagedRuntimeArtifact(policy, {
    provider: "scient",
    target: policy.target,
    version,
    artifactName: policy.artifactName,
    url: `${policy.releaseUrlPrefix}${version}/${policy.artifactName}`,
    checksum: { algorithm: "sha256", digest },
    size: bytes.length,
    catalogRevision: `test:scient:${version}`,
  })!;
}

async function installedFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-agent-download-test-"));
  roots.push(root);
  const previous = artifact("0.1.0");
  const seed = new ManagedScientAgentRuntime(root, {
    download: async ({ destination }) => {
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFSP.writeFile(destination, bytes, { flag: "wx" });
    },
    smoke: async () => undefined,
  });
  await seed.install({ artifact: previous, signal: new AbortController().signal });
  const otherState = NodePath.join(root, "provider-runtimes", "omp", "sentinel");
  await NodeFSP.mkdir(NodePath.dirname(otherState), { recursive: true });
  await NodeFSP.writeFile(otherState, "keep");
  return { root, previous, otherState, previousState: await seed.readState() };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

it("recovers the Scient download and still runs smoke, admission, and qualification before committing", async () => {
  const { root, previous, otherState } = await installedFixture();
  const events: string[] = [];
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
    .mockImplementationOnce(async () => {
      events.push("download");
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    });
  vi.stubGlobal("fetch", fetch);
  const runtime = new ManagedScientAgentRuntime(root, {
    smoke: async (executable, args) => {
      expect(await NodeFSP.readFile(executable)).toEqual(bytes);
      expect(args).toEqual(["--runtime-info"]);
      events.push("smoke");
    },
  });
  const candidate = artifact("0.2.0");
  await runtime.install({
    artifact: candidate,
    signal: new AbortController().signal,
    beforeActivate: async () => {
      events.push("admission");
    },
    qualify: async ({ executablePath }) => {
      expect(await NodeFSP.readFile(executablePath)).toEqual(bytes);
      events.push("qualification");
    },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(events).toEqual(["download", "smoke", "admission", "qualification"]);
  expect(await runtime.status(candidate)).toMatchObject({
    installed: true,
    selected: true,
    activeVersion: "0.2.0",
  });
  expect(await runtime.readState()).toMatchObject({ previousVersion: "0.1.0" });
  expect(await NodeFSP.readFile(runtime.launchPath(previous))).toEqual(bytes);
  expect(await NodeFSP.readFile(otherState, "utf8")).toBe("keep");
});

it.each(["checksum", "smoke", "admission", "qualification", "cancellation"] as const)(
  "preserves the installed release when %s refuses an update after a transient response",
  async (failure) => {
    const { root, previous, previousState, otherState } = await installedFixture();
    const controller = new AbortController();
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream({
              cancel: () => {
                if (failure === "cancellation") controller.abort();
              },
            }),
            { status: 503 },
          ),
      )
      .mockResolvedValueOnce(
        new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
      );
    vi.stubGlobal("fetch", fetch);
    const smoke = vi.fn(async () => {
      if (failure === "smoke") throw new Error("refused smoke");
    });
    const beforeActivate = vi.fn(async () => {
      if (failure === "admission") throw new Error("refused admission");
    });
    const qualify = vi.fn(async () => {
      if (failure === "qualification") throw new Error("refused qualification");
    });
    const runtime = new ManagedScientAgentRuntime(root, { smoke });
    const candidate =
      failure === "checksum" ? artifact("0.2.0", "0".repeat(64)) : artifact("0.2.0");
    await expect(
      runtime.install({ artifact: candidate, signal: controller.signal, beforeActivate, qualify }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(failure === "cancellation" ? 1 : 2);
    if (failure === "checksum" || failure === "cancellation") expect(smoke).not.toHaveBeenCalled();
    if (failure === "checksum" || failure === "cancellation" || failure === "smoke")
      expect(beforeActivate).not.toHaveBeenCalled();
    if (failure !== "qualification") expect(qualify).not.toHaveBeenCalled();
    expect(await runtime.readState()).toEqual(previousState);
    expect(await runtime.status(previous)).toMatchObject({
      installed: true,
      selected: true,
      activeVersion: "0.1.0",
    });
    expect(await NodeFSP.readFile(runtime.launchPath(previous))).toEqual(bytes);
    await expect(NodeFSP.stat(runtime.launchPath(candidate))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await NodeFSP.readdir(NodePath.join(root, "provider-runtimes", "scient-agent", "staging")),
    ).toEqual([]);
    expect(await NodeFSP.readFile(otherState, "utf8")).toBe("keep");
  },
);

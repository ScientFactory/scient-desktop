// @effect-diagnostics nodeBuiltinImport:off -- Controlled transport exercises the real private installer without network or credentials.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeZlib from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hydrateManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import { ManagedScientAgentRuntime } from "./managedScientAgentRuntime.ts";
import { resolveScientAgentArtifactPolicy } from "./scientAgentManifest.ts";

vi.mock("node:timers/promises", { spy: true });
// The transient-response backoff resolves at once but still honours cancellation.
vi.mocked(NodeTimersPromises.setTimeout).mockImplementation((async (
  _delay: number,
  value: unknown,
  options?: { signal?: AbortSignal },
) => {
  options?.signal?.throwIfAborted();
  return value;
}) as never);

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
      .mockImplementation(
        async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
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
    // A wrong digest rules out each copy in turn: Scient's after its 503, then GitHub's.
    expect(fetch).toHaveBeenCalledTimes(
      failure === "cancellation" ? 1 : failure === "checksum" ? 3 : 2,
    );
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

describe("installing from the compressed copy", () => {
  const sha256 = (data: Buffer) => NodeCrypto.createHash("sha256").update(data).digest("hex");
  const packed = NodeZlib.zstdCompressSync(bytes);

  /** The catalog's compressed copy: by default `packed`, the zstd of `bytes`. */
  function compressedArtifact(version: string, copy: Buffer = packed) {
    const policy = resolveScientAgentArtifactPolicy({ platform: "darwin", arch: "arm64" })!;
    return hydrateManagedRuntimeArtifact(
      policy,
      {
        provider: "scient",
        target: policy.target,
        version,
        artifactName: policy.artifactName,
        url: `${policy.releaseUrlPrefix}${version}/${policy.artifactName}`,
        checksum: { algorithm: "sha256", digest: sha256(bytes) },
        size: bytes.length,
        catalogRevision: `test:scient:${version}`,
      },
      {
        format: "zstd",
        size: copy.length,
        checksum: { algorithm: "sha256", digest: sha256(copy) },
      },
    )!;
  }

  /** Serves `zst` for compressed copies and `bytes` for binaries, recording every URL. */
  function serve(zst: Buffer, urls: string[], onFetch?: () => void) {
    return vi.fn(async (url: URL) => {
      urls.push(url.toString());
      onFetch?.();
      const body = url.pathname.endsWith(".zst") ? zst : bytes;
      return new Response(new Uint8Array(body), {
        headers: { "content-length": String(body.length) },
      });
    });
  }

  async function expectInstalled(
    runtime: ManagedScientAgentRuntime,
    root: string,
    version: string,
  ) {
    expect(await runtime.status(compressedArtifact(version))).toMatchObject({
      installed: true,
      selected: true,
      activeVersion: version,
    });
    expect(await NodeFSP.readFile(runtime.launchPath(compressedArtifact(version)))).toEqual(bytes);
    expect(
      await NodeFSP.readdir(NodePath.join(root, "provider-runtimes", "scient-agent", "staging")),
    ).toEqual([]);
  }

  it("names the copy beside the binary on both servers", () => {
    expect(compressedArtifact("0.2.0").compressed).toEqual({
      format: "zstd",
      artifactName: "scient-agent-darwin-arm64.zst",
      url: "https://github.com/ScientFactory/scient-agent/releases/download/v0.2.0/scient-agent-darwin-arm64.zst",
      mirrorUrl:
        "https://downloads.scientfactory.com/scient-agent/v0.2.0/scient-agent-darwin-arm64.zst",
      size: packed.length,
      checksum: { algorithm: "sha256", digest: sha256(packed) },
    });
  });

  it("downloads only the compressed copy and installs the binary it unpacks to", async () => {
    const { root } = await installedFixture();
    const urls: string[] = [];
    vi.stubGlobal("fetch", serve(packed, urls));
    const onCompressedFallback = vi.fn();
    const runtime = new ManagedScientAgentRuntime(root, { smoke: async () => undefined });
    await runtime.install({
      artifact: compressedArtifact("0.2.0"),
      signal: new AbortController().signal,
      onCompressedFallback,
    });
    expect(urls).toEqual([
      "https://downloads.scientfactory.com/scient-agent/v0.2.0/scient-agent-darwin-arm64.zst",
    ]);
    expect(onCompressedFallback).not.toHaveBeenCalled();
    await expectInstalled(runtime, root, "0.2.0");
  });

  it.each([
    { failure: "a damaged copy on both servers", catalogCopy: packed, served: Buffer.from("junk") },
    {
      failure: "a copy that unpacks to other bytes",
      catalogCopy: NodeZlib.zstdCompressSync(Buffer.from("other bytes")),
      served: NodeZlib.zstdCompressSync(Buffer.from("other bytes")),
    },
  ])("falls back to the binary after $failure", async ({ catalogCopy, served }) => {
    const { root } = await installedFixture();
    const urls: string[] = [];
    vi.stubGlobal("fetch", serve(served, urls));
    const onCompressedFallback = vi.fn();
    const runtime = new ManagedScientAgentRuntime(root, { smoke: async () => undefined });
    await runtime.install({
      artifact: compressedArtifact("0.2.0", catalogCopy),
      signal: new AbortController().signal,
      onCompressedFallback,
    });
    expect(onCompressedFallback).toHaveBeenCalledOnce();
    expect(urls.at(-1)).toBe(
      "https://downloads.scientfactory.com/scient-agent/v0.2.0/scient-agent-darwin-arm64",
    );
    await expectInstalled(runtime, root, "0.2.0");
  });

  it("stops without the binary when told not to fall back, or when cancelled", async () => {
    const { root, previousState } = await installedFixture();
    const runtime = new ManagedScientAgentRuntime(root, { smoke: async () => undefined });
    const urls: string[] = [];
    vi.stubGlobal("fetch", serve(Buffer.from("junk"), urls));
    await expect(
      runtime.install({
        artifact: compressedArtifact("0.2.0"),
        signal: new AbortController().signal,
        onCompressedFallback: (cause) => {
          throw new Error("no fallback", { cause });
        },
      }),
    ).rejects.toThrow("no fallback");
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      serve(packed, urls, () => controller.abort()),
    );
    const onCompressedFallback = vi.fn();
    await expect(
      runtime.install({
        artifact: compressedArtifact("0.2.0"),
        signal: controller.signal,
        onCompressedFallback,
      }),
    ).rejects.toThrow();
    expect(onCompressedFallback).not.toHaveBeenCalled();
    expect(urls.every((url) => url.endsWith(".zst"))).toBe(true);
    expect(await runtime.readState()).toEqual(previousState);
    expect(
      await NodeFSP.readdir(NodePath.join(root, "provider-runtimes", "scient-agent", "staging")),
    ).toEqual([]);
  });

  it("downloads the binary where this process cannot unpack zstd", async () => {
    const { root } = await installedFixture();
    const urls: string[] = [];
    vi.stubGlobal("fetch", serve(packed, urls));
    const runtime = new ManagedScientAgentRuntime(root, {
      smoke: async () => undefined,
      unpackZstd: undefined,
    });
    await runtime.install({
      artifact: compressedArtifact("0.2.0"),
      signal: new AbortController().signal,
    });
    expect(urls).toEqual([
      "https://downloads.scientfactory.com/scient-agent/v0.2.0/scient-agent-darwin-arm64",
    ]);
    await expectInstalled(runtime, root, "0.2.0");
  });
});

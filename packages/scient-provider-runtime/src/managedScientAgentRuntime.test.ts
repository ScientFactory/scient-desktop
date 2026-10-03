// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise private installation and durable receipts with fixture bytes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import {
  hydrateManagedRuntimeArtifact,
  managedRuntimeArtifactReceipt,
} from "./managedRuntimeArtifact.ts";
import { ManagedScientAgentRuntime } from "./managedScientAgentRuntime.ts";
import { resolveScientAgentArtifactPolicy } from "./scientAgentManifest.ts";

it("persists and repairs the exact Scient release without touching an OMP installation", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-agent-runtime-test-"));
  try {
    const bytes = Buffer.from("fixture Scient executable");
    const policy = resolveScientAgentArtifactPolicy({ platform: "darwin", arch: "arm64" })!;
    const artifact = hydrateManagedRuntimeArtifact(policy, {
      provider: "scient",
      target: policy.target,
      version: "0.1.0",
      artifactName: policy.artifactName,
      url: `${policy.releaseUrlPrefix}0.1.0/${policy.artifactName}`,
      checksum: {
        algorithm: "sha256",
        digest: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      },
      size: bytes.length,
      catalogRevision: "test:scient:0.1.0",
    })!;
    const otherState = NodePath.join(root, "provider-runtimes", "omp", "sentinel");
    await NodeFSP.mkdir(NodePath.dirname(otherState), { recursive: true });
    await NodeFSP.writeFile(otherState, "keep");
    const runtime = new ManagedScientAgentRuntime(root, {
      download: async ({ destination }) => {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, bytes, { flag: "wx" });
      },
      smoke: async (executable, args) => {
        expect(await NodeFSP.readFile(executable)).toEqual(bytes);
        expect(args).toEqual(["--runtime-info"]);
      },
    });
    await runtime.install({ artifact, signal: new AbortController().signal });
    const reopened = new ManagedScientAgentRuntime(root);
    const state = await reopened.readState();
    expect(state?.schemaVersion).toBe(3);
    expect(state?.schemaVersion === 3 ? state.activeArtifact : undefined).toEqual(
      managedRuntimeArtifactReceipt(artifact),
    );
    expect(await reopened.status(artifact)).toMatchObject({
      installed: true,
      selected: true,
      activeVersion: "0.1.0",
    });
    await runtime.install({ artifact, signal: new AbortController().signal });
    await runtime.remove();
    expect(await reopened.status(artifact)).toMatchObject({ installed: false, selected: false });
    expect(await NodeFSP.readFile(otherState, "utf8")).toBe("keep");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

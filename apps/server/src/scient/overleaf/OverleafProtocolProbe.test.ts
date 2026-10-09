// @effect-diagnostics nodeBuiltinImport:off -- Run the actual local qualification CLI against real Git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  cloudProbeGitUrl,
  probeAcceptance,
  redactProbePushOutput,
} from "./OverleafProtocolProbe.ts";
import type { OverleafRepository } from "./OverleafRepository.ts";

describe("Cloud probe boundaries", () => {
  it("accepts only credential-free official Cloud project URLs", () => {
    const id = "0123456789abcdef01234567";
    for (const url of [`https://www.overleaf.com/project/${id}`, `https://git.overleaf.com/${id}`])
      expect(cloudProbeGitUrl(url)).toBe(`https://git.overleaf.com/${id}`);
    for (const url of [
      `https://token@git.overleaf.com/${id}`,
      `http://git.overleaf.com/${id}`,
      `https://git.overleaf.com/${id}?token=x`,
      `https://www.overleaf.com/project/${id}#token`,
      `https://git.overleaf.com.evil/${id}`,
      `file:///tmp/project`,
      "git clone https://git.overleaf.com/project",
    ])
      expect(cloudProbeGitUrl(url)).toBeNull();
  });
  it("redacts raw and encoded credentials, URLs and terminal controls", () => {
    const token = Buffer.from("probe?private&token");
    const output = redactProbePushOutput(
      `\u001b[31m${token.toString()} ${encodeURIComponent(token.toString())} https://git.overleaf.com/project`,
      token,
    );
    expect(output).not.toContain(token.toString());
    expect(output).not.toContain(encodeURIComponent(token.toString()));
    expect(output).not.toContain("https://");
    expect(output).not.toContain("\u001b");
  });
  it.effect(
    "preserves unknown acceptance when remote history was rewritten or exceeds evidence",
    () =>
      Effect.gen(function* () {
        const repository = {
          treesSince: () => Effect.succeed([]),
          isAncestor: () => Effect.succeed(false),
        } as unknown as OverleafRepository["Service"];
        expect(
          yield* probeAcceptance({
            repository,
            repo: "/unused",
            before: "base",
            head: { commit: "new", tree: "different" },
            candidate: { commit: "lost", tree: "candidate" },
          }),
        ).toBe("unknown");
      }),
  );
  it("rehearses publishing, rejection, renames and lost-ack verification with real Git", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-probe-cli-"));
    const report = NodePath.join(root, "report.json");
    try {
      NodeChildProcess.execFileSync(
        process.execPath,
        [
          NodePath.resolve(import.meta.dirname, "../../../scripts/qualify-overleaf-git.ts"),
          "--output",
          report,
        ],
        { encoding: "utf8", timeout: 60_000, stdio: "pipe" },
      );
      const contents = await NodeFSP.readFile(report, "utf8");
      expect(contents).toContain('"local-rehearsal"');
      for (const name of [
        "initial-push",
        "stale-push",
        "stale-push-left-remote-unchanged",
        "file-and-folder-rename",
        "simulated-lost-ack",
        "acceptance-after-browser-revert",
        "final-independent-read",
      ])
        expect(contents).toMatch(new RegExp(`"name": "${name}",\\s*"status": "passed"`, "u"));
      expect(contents).toContain('"bounded-history-tree"');
      expect(contents).toContain('"simulatedAcknowledgementOnly": true');
      // No report overwrite or implicit run against an existing project/report.
      expect(() =>
        NodeChildProcess.execFileSync(
          process.execPath,
          [
            NodePath.resolve(import.meta.dirname, "../../../scripts/qualify-overleaf-git.ts"),
            "--output",
            report,
          ],
          { timeout: 10_000, stdio: "pipe" },
        ),
      ).toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }, 70_000);
});

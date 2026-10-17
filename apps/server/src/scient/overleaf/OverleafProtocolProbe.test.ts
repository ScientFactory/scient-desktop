// @effect-diagnostics nodeBuiltinImport:off -- Run the actual local qualification CLI against real Git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  cloudProbeGitUrl,
  classifyProbeGitFailure,
  probeAcceptance,
  redactProbePushOutput,
  runProtocolProbe,
  type ProbeObservation,
} from "./OverleafProtocolProbe.ts";
import { OverleafGitError, OverleafGitExecutor } from "./OverleafGitExecutor.ts";
import type { OverleafRepository } from "./OverleafRepository.ts";

describe("Cloud probe boundaries", () => {
  it("reports actionable startup categories without echoing Git errors or credentials", () => {
    const secret = "private-probe-token";
    for (const [detail, category] of [
      [
        `fatal: Authentication failed for https://git:${secret}@git.overleaf.com/project`,
        "authentication-or-access-denied",
      ],
      ["The requested URL returned error: 403", "authentication-or-access-denied"],
      ["repository not found", "project-not-found"],
      ["SSL certificate problem", "tls"],
      ["Could not resolve host", "dns"],
      ["redirect denied", "redirect"],
      ["Failed to connect", "connection"],
      ["cannot run askpass", "credential-prompt"],
      [`Unexpected remote output ${secret}`, "unclassified"],
    ] as const) {
      const diagnostic = classifyProbeGitFailure(
        new OverleafGitError({
          reason: "non-zero-exit",
          exitCode: 128,
          detail,
        }),
      );
      expect(diagnostic).toEqual({ reason: "non-zero-exit", exitCode: 128, category });
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
      expect(JSON.stringify(diagnostic)).not.toContain("https://");
    }
    expect(
      classifyProbeGitFailure(
        new OverleafGitError({
          reason: "timeout",
          exitCode: null,
          detail: secret,
        }),
      ),
    ).toEqual({ reason: "timeout", exitCode: -1, category: "timeout" });
  });
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
  it.effect("does not attempt a stale push when browser confirmation lacks the saved edit", () =>
    Effect.gen(function* () {
      const prefix = "scient-probe-00000000-0000-4000-8000-000000000001";
      for (const changedHead of [false, true]) {
        let fetches = 0;
        let pushes = 0;
        const observations: ProbeObservation[] = [];
        const initial = { commit: "initial", tree: "initial-tree" };
        const first = { commit: "first", tree: "first-tree" };
        const repository = {
          initialize: () => Effect.void,
          discoverBranch: () => Effect.succeed("main"),
          fetch: () =>
            Effect.sync(() => {
              fetches++;
              if (fetches === 1) return initial;
              if (fetches < 4 || !changedHead) return first;
              return { commit: "unrelated-edit", tree: "unrelated-tree" };
            }),
          readTree: ({ tree }: { tree: string }) =>
            Effect.succeed(
              tree === initial.tree ? [] : [{ path: `${prefix}/review.tex`, oid: "review" }],
            ),
          writeBlob: () => Effect.succeed("blob"),
          writeTree: () => Effect.succeed(first.tree),
          commit: () => Effect.succeed(first.commit),
          readBlob: () => Effect.succeed(new TextEncoder().encode("PROBE_INITIAL\n")),
          push: () =>
            Effect.sync(() => {
              pushes++;
              return { _tag: "accepted" };
            }),
        } as unknown as OverleafRepository["Service"];
        const result = yield* runProtocolProbe({
          repository,
          git: OverleafGitExecutor.of({
            availability: Effect.die("unused"),
            execute: () => Effect.die("unused"),
          }),
          repo: "/unused",
          witnessRepo: "/unused-witness",
          gitUrl: "/unused-remote",
          token: new Uint8Array(),
          prefix,
          hooks: {
            browser: () => Effect.void,
            reviewMetadata: () => Effect.void,
            observe: (observation) =>
              Effect.sync(() => {
                observations.push(observation);
              }),
          },
        }).pipe(Effect.provide(NodeServices.layer), Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(pushes).toBe(1);
        expect(observations).toContainEqual({
          name: "browser-edit-saved",
          status: "failed",
          facts: { markerObserved: false, headChanged: changedHead },
        });
        expect(observations.some((observation) => observation.name === "stale-push")).toBe(false);
      }
    }),
  );
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
        "browser-edit-saved",
        "stale-push",
        "stale-push-left-remote-unchanged",
        "file-and-folder-rename",
        "simulated-lost-ack",
        "acceptance-after-browser-revert",
        "browser-revert-saved",
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

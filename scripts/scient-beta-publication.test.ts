// @effect-diagnostics nodeBuiltinImport:off - Rehearse the Linux publisher with local command fixtures and no network credential.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const workflow = parse(
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "../.github/workflows/release.yml"),
    "utf8",
  ),
) as {
  jobs: { publish: { steps: Array<{ name?: string; run?: string }> } };
};
const step = (name: string) => {
  const run = workflow.jobs.publish.steps.find((entry) => entry.name === name)?.run;
  if (!run) throw new Error(`Missing publisher step: ${name}`);
  return run;
};
const sourceSha = "a".repeat(40);
const betaVersion = "0.6.23-beta.20261010.1";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This synchronous platform gate skips Linux Bash publisher fixtures on native Windows.
describe.skipIf(process.platform === "win32")("Scient publication rehearsal", () => {
  it.each(["stable", "beta"])("publishes %s only into its owning repository", (channel) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-publish-fixture-"));
    const bin = NodePath.join(root, "bin");
    const version = channel === "beta" ? betaVersion : "0.6.23";
    const repository =
      channel === "beta" ? "ScientFactory/scient-desktop-beta" : "ScientFactory/scient-desktop";
    try {
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(NodePath.join(root, "release-assets"));
      NodeFS.writeFileSync(NodePath.join(root, "release-assets/fixture.txt"), "immutable fixture");
      NodeFS.writeFileSync(
        NodePath.join(bin, "gh"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  if (args[1].endsWith('/releases/latest')) process.stdout.write(process.env.RELEASE_CHANNEL === 'beta' ? 'v0.6.22' : process.env.RELEASE_TAG);
  else if (args[1] === 'repos/ScientFactory/scient-desktop-beta') process.stdout.write('main');
  else process.exit(2);
} else if (args[0] === 'release' && ['create', 'edit'].includes(args[1])) {
} else if (args[0] === 'release' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ isDraft: false, isPrerelease: true }));
} else if (args[0] === 'release' && args[1] === 'download') {
  const destination = args[args.indexOf('--dir') + 1];
  for (const name of fs.readdirSync('release-assets')) fs.copyFileSync(path.join('release-assets', name), path.join(destination, name));
} else process.exit(2);
`,
        { mode: 0o700 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "git"),
        `#!/usr/bin/env node
if (process.argv[2] !== 'ls-remote') process.exit(2);
process.stdout.write(process.env.SOURCE_SHA + '\\trefs/tags/' + process.env.RELEASE_TAG + '\\n');
`,
        { mode: 0o700 },
      );
      const calls = NodePath.join(root, "calls.jsonl");
      NodeChildProcess.execFileSync(
        "bash",
        ["-c", step("Stage, verify, and publish the immutable release")],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GH_TOKEN: "synthetic-unused-token",
            CALLS: calls,
            RUNNER_TEMP: root,
            RELEASE_CHANNEL: channel,
            DISTRIBUTION_REPOSITORY: repository,
            SCIENT_DESKTOP_CANONICAL_REPOSITORY: "ScientFactory/scient-desktop",
            SCIENT_DESKTOP_BETA_REPOSITORY: "ScientFactory/scient-desktop-beta",
            GITHUB_REPOSITORY: "ScientFactory/scient-desktop",
            RELEASE_TAG: `v${version}`,
            RELEASE_VERSION: version,
            SOURCE_SHA: sourceSha,
            ALLOW_UNSIGNED_WINDOWS: "false",
            RELEASE_NOTES_BASE64: Buffer.from("Approved fixture notes").toString("base64"),
          },
          stdio: "pipe",
        },
      );
      const commands = NodeFS.readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const mutations = commands.filter(
        (args) => args[0] === "release" && ["create", "edit"].includes(args[1]!),
      );
      expect(mutations).toHaveLength(2);
      for (const args of mutations) expect(args[args.indexOf("--repo") + 1]).toBe(repository);
      if (channel === "beta") {
        for (const args of mutations) {
          expect(args).toContain("--prerelease");
          expect(args).toContain("--latest=false");
        }
        expect(mutations[0]?.[mutations[0].indexOf("--target") + 1]).toBe("main");
      } else {
        expect(mutations[0]?.[mutations[0].indexOf("--target") + 1]).toBe(sourceSha);
        expect(mutations[1]).toContain("--latest");
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses missing or stale native receipts for an immutable Beta candidate", () => {
    const qualified = {
      sourceSha,
      version: betaVersion,
      artifactDigest: "sha256:fixture",
      paths: ["stable-to-beta", "beta-to-beta", "beta-to-stable", "stable-isolation"].map(
        (name) => ({ name, passed: true, receipt: "https://example.org/native-receipt" }),
      ),
      platforms: ["mac-arm64", "mac-x64", "windows-x64", "linux-x64"].map((name) => ({
        name,
        passed: true,
        receipt: "https://example.org/native-receipt",
      })),
    };
    const qualify = (receipt: unknown) =>
      NodeChildProcess.spawnSync(
        "bash",
        ["-c", step("Require Beta update-path qualification for this candidate")],
        {
          env: {
            ...process.env,
            BETA_TOKEN: "synthetic-unused-token",
            QUALIFICATION: JSON.stringify(receipt),
            SOURCE_SHA: sourceSha,
            RELEASE_VERSION: betaVersion,
            ARTIFACT_DIGEST: qualified.artifactDigest,
          },
          stdio: "pipe",
        },
      ).status;
    expect(qualify(qualified)).toBe(0);
    expect(qualify({})).not.toBe(0);
    expect(qualify({ ...qualified, sourceSha: "b".repeat(40) })).not.toBe(0);
    expect(qualify({ ...qualified, artifactDigest: "sha256:another-candidate" })).not.toBe(0);
    expect(qualify({ ...qualified, paths: qualified.paths.slice(1) })).not.toBe(0);
    expect(qualify({ ...qualified, platforms: qualified.platforms.slice(1) })).not.toBe(0);
  });
});

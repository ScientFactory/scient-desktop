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
  jobs: Record<"publish" | "beta-inventory", { steps: Array<{ name?: string; run?: string }> }>;
};
const step = (name: string, job: "publish" | "beta-inventory" = "publish") => {
  const run = workflow.jobs[job].steps.find((entry) => entry.name === name)?.run;
  if (!run) throw new Error(`Missing publisher step: ${name}`);
  return run;
};
const sourceSha = "a".repeat(40);
const betaVersion = "0.6.23-beta.20261010.1";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This synchronous platform gate skips Linux Bash publisher fixtures on native Windows.
describe.skipIf(process.platform === "win32")("Scient publication rehearsal", () => {
  it("reads draft reservations with the isolated token and fails closed before packaging", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-beta-inventory-"));
    const bin = NodePath.join(root, "bin");
    const output = NodePath.join(root, "output.txt");
    const calls = NodePath.join(root, "calls.jsonl");
    try {
      NodeFS.mkdirSync(bin);
      NodeFS.writeFileSync(
        NodePath.join(bin, "gh"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (process.env.GH_TOKEN !== 'synthetic-beta-only-token') process.exit(2);
if (args.includes('repos/ScientFactory/scient-desktop/releases/latest')) process.stdout.write('v0.6.23');
else if (args.includes('repos/ScientFactory/scient-desktop-beta/releases?per_page=100')) {
  if (process.env.FAILURE === 'inventory-unavailable') process.exit(2);
  process.stdout.write(JSON.stringify([
    [{tag_name:'v0.6.24-beta.20261011.2',draft:false}],
    [{tag_name:'v0.6.24-beta.20261011.12',draft:true}]
  ]));
} else process.exit(2);
`,
        { mode: 0o700 },
      );
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "synthetic-beta-only-token",
        CALLS: calls,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "ScientFactory/scient-desktop",
        GITHUB_REF: "refs/heads/main",
        SCIENT_DESKTOP_CANONICAL_REPOSITORY: "ScientFactory/scient-desktop",
        SCIENT_DESKTOP_BETA_REPOSITORY: "ScientFactory/scient-desktop-beta",
        RELEASES_ENABLED: "true",
      };
      const run = (overrides: Record<string, string> = {}) =>
        NodeChildProcess.spawnSync(
          "bash",
          ["-c", step("Read published and draft Beta versions", "beta-inventory")],
          { cwd: root, env: { ...env, ...overrides }, stdio: "pipe" },
        );
      expect(run().status).toBe(0);
      expect(NodeFS.readFileSync(output, "utf8")).toBe(
        'latest_stable_version=v0.6.23\nbeta_tags=["v0.6.24-beta.20261011.2","v0.6.24-beta.20261011.12"]\n',
      );
      const commands = NodeFS.readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands[1]).toContain("--paginate");
      expect(commands[1]).toContain("--slurp");
      expect(commands[1]).not.toContain("--jq");
      for (const overrides of [
        { GH_TOKEN: "" },
        { RELEASES_ENABLED: "false" },
        { GITHUB_REF: "refs/heads/feature" },
        { FAILURE: "inventory-unavailable" },
      ]) {
        NodeFS.rmSync(output);
        expect(run(overrides).status).not.toBe(0);
        expect(NodeFS.existsSync(output)).toBe(false);
        NodeFS.writeFileSync(output, "");
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { channel: "stable", failure: "none" },
    { channel: "beta", failure: "none" },
    { channel: "beta", failure: "corrupt-upload" },
    { channel: "beta", failure: "stable-advanced" },
  ])(
    "publishes $channel only into its owning repository, failure=$failure",
    ({ channel, failure }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-publish-fixture-"));
      const bin = NodePath.join(root, "bin");
      const version = channel === "beta" ? betaVersion : "0.6.23";
      const repository =
        channel === "beta" ? "ScientFactory/scient-desktop-beta" : "ScientFactory/scient-desktop";
      try {
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(root, "release-assets"));
        NodeFS.writeFileSync(
          NodePath.join(root, "release-assets/fixture.txt"),
          "immutable fixture",
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "gh"),
          `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  if (args[1].endsWith('/releases/latest')) process.stdout.write(process.env.RELEASE_CHANNEL === 'beta' ? (process.env.FAILURE === 'stable-advanced' ? 'v0.6.23' : 'v0.6.22') : process.env.RELEASE_TAG);
  else if (args[1] === 'repos/ScientFactory/scient-desktop-beta') process.stdout.write('main');
  else process.exit(2);
} else if (args[0] === 'release' && ['create', 'edit'].includes(args[1])) {
  if (args[1] === 'create') fs.writeFileSync(process.env.NOTES_RECEIPT, fs.readFileSync(args[args.indexOf('--notes-file') + 1]));
} else if (args[0] === 'release' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ isDraft: false, isPrerelease: true }));
} else if (args[0] === 'release' && args[1] === 'download') {
  const destination = args[args.indexOf('--dir') + 1];
  for (const name of fs.readdirSync('release-assets')) fs.copyFileSync(path.join('release-assets', name), path.join(destination, name));
  if (process.env.FAILURE === 'corrupt-upload') fs.writeFileSync(path.join(destination, 'fixture.txt'), 'modified upload');
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
        const result = NodeChildProcess.spawnSync(
          "bash",
          ["-c", step("Stage, verify, and publish the immutable release")],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              GH_TOKEN: "synthetic-unused-token",
              CALLS: calls,
              FAILURE: failure,
              NOTES_RECEIPT: NodePath.join(root, "published-notes.md"),
              RUNNER_TEMP: root,
              RELEASE_CHANNEL: channel,
              DISTRIBUTION_REPOSITORY: repository,
              SCIENT_DESKTOP_CANONICAL_REPOSITORY: "ScientFactory/scient-desktop",
              SCIENT_DESKTOP_BETA_REPOSITORY: "ScientFactory/scient-desktop-beta",
              GITHUB_REPOSITORY: "ScientFactory/scient-desktop",
              RELEASE_TAG: `v${version}`,
              RELEASE_VERSION: version,
              SOURCE_SHA: sourceSha,
              ALLOW_UNSIGNED_WINDOWS: channel === "beta" ? "true" : "false",
              RELEASE_NOTES_BASE64:
                channel === "beta" ? "" : Buffer.from("Approved fixture notes").toString("base64"),
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
        if (failure !== "none") {
          expect(result.status).not.toBe(0);
          expect(mutations).toHaveLength(failure === "corrupt-upload" ? 1 : 0);
          expect(mutations.some((args) => args[1] === "edit")).toBe(false);
          return;
        }
        expect(result.status).toBe(0);
        expect(mutations).toHaveLength(2);
        for (const args of mutations) expect(args[args.indexOf("--repo") + 1]).toBe(repository);
        if (channel === "beta") {
          const notes = NodeFS.readFileSync(NodePath.join(root, "published-notes.md"), "utf8");
          expect(notes).toContain("Windows note");
          expect(notes).not.toContain("Approved fixture notes");
          for (const args of mutations) {
            expect(args).toContain("--prerelease");
            expect(args).toContain("--latest=false");
          }
          expect(mutations[0]?.[mutations[0].indexOf("--target") + 1]).toBe("main");
        } else {
          expect(NodeFS.readFileSync(NodePath.join(root, "published-notes.md"), "utf8")).toBe(
            "Approved fixture notes",
          );
          expect(mutations[0]?.[mutations[0].indexOf("--target") + 1]).toBe(sourceSha);
          expect(mutations[1]).toContain("--latest");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("requires the isolated publishing credential without a manual qualification receipt", () => {
    const qualify = (token: string) =>
      NodeChildProcess.spawnSync(
        "bash",
        ["-c", step("Require isolated Beta publishing credential")],
        {
          env: {
            ...process.env,
            BETA_TOKEN: token,
          },
          stdio: "pipe",
        },
      ).status;
    expect(qualify("synthetic-unused-token")).toBe(0);
    expect(qualify("")).not.toBe(0);
  });
});

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { inspectScientSeams } from "./scient-seam-check.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-seam-test-"));
  directories.push(cwd);
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path, content) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), content);
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Seam test");
  git("config", "user.email", "seam-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", NodePath.join(cwd, "no-hooks"));
  const commit = () => {
    git("add", "--all");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  write("host.ts", "export const host = true;\n");
  write("next-host.ts", "export const nextHost = true;\n");
  const upstream = commit();
  write("upstream-state.json", JSON.stringify({ integrationBase: upstream }));
  write("host.ts", "export const ScientFeature = true;\n");
  write("owned/feature.ts", "export const feature = true;\n");
  const manifest = {
    schemaVersion: 2,
    owner: "ScientFactory",
    ownedRoots: ["owned"],
    ownedFiles: [],
    upstreamMounts: [
      { path: "host.ts", anchor: "ScientFeature", purpose: "Mount the fixture feature" },
    ],
    onboardingDiffSignals: ["ScientFeature"],
  };
  const saveManifest = () => write("scient-onboarding-seams.json", JSON.stringify(manifest));
  saveManifest();
  const base = commit();
  const inspect = (args = ["--base", base], names = ["onboarding"]) =>
    inspectScientSeams(args, { cwd, names });
  const messages = (result) =>
    result.checks.flatMap((check) => check.findings.map((finding) => finding.message));
  return { cwd, git, write, commit, upstream, base, manifest, saveManifest, inspect, messages };
}

function connectorFixture() {
  const f = fixture();
  const policy = JSON.parse(
    NodeFS.readFileSync(new URL("../scient-extensions-seams.json", import.meta.url), "utf8"),
  );
  const manifest = { ...f.manifest, extensionsDiffSignals: policy.extensionsDiffSignals };
  delete manifest.onboardingDiffSignals;
  const saveManifest = () => f.write("scient-extensions-seams.json", JSON.stringify(manifest));
  saveManifest();
  const base = f.commit();
  manifest.diffSignalRefinements = policy.diffSignalRefinements;
  saveManifest();
  const inspect = (args = ["--base", base]) => f.inspect(args, ["extensions"]);
  return { ...f, manifest, saveManifest, base, inspect };
}

describe("Scient seam snapshot verification", () => {
  it.each([false, true])("does not retain temporary files or Git objects (failure: %s)", (fail) => {
    const f = fixture();
    f.write(
      "scratch.txt",
      "synthetic private scratch, never a Git object in the real repository\n",
    );
    const blob = f.git("hash-object", "scratch.txt");
    const indexPath = f.git("rev-parse", "--path-format=absolute", "--git-path", "index");
    const indexBefore = NodeFS.readFileSync(indexPath);
    const objectsBefore = f.git("count-objects", "-v");
    const temporaryDirectories = () =>
      NodeFS.readdirSync(NodeOS.tmpdir())
        .filter((name) => name.startsWith("scient-seam-snapshot-"))
        .sort();
    const before = temporaryDirectories();
    const result = f.inspect(
      fail ? ["--base", f.base, "--upstream-ref", "missing-upstream"] : undefined,
    );
    expect(result.checks[0].status).toBe(fail ? "unavailable" : "passed");
    expect(temporaryDirectories()).toEqual(before);
    expect(NodeFS.readFileSync(indexPath)).toEqual(indexBefore);
    expect(f.git("count-objects", "-v")).toBe(objectsBefore);
    expect(() => f.git("cat-file", "-e", blob)).toThrow();
    if (!fail) expect(() => f.git("cat-file", "-e", result.context.tree)).toThrow();
  });

  it("keeps index snapshot objects private too", () => {
    const f = fixture();
    f.write("staged.ts", "new staged content\n");
    f.git("add", "staged.ts");
    const indexPath = f.git("rev-parse", "--path-format=absolute", "--git-path", "index");
    const before = NodeFS.readFileSync(indexPath);
    const result = f.inspect(["--base", f.base, "--snapshot", "index"]);
    expect(result.checks[0].status).toBe("passed");
    expect(NodeFS.readFileSync(indexPath)).toEqual(before);
    expect(() => f.git("cat-file", "-e", result.context.tree)).toThrow();
  });

  it("batches changed content once for all checks and lists references without scanning their contents", () => {
    const f = fixture();
    for (const name of ["skills", "analysis", "latex"]) {
      const signals = name === "skills" ? "skillDiffSignals" : `${name}DiffSignals`;
      f.write(
        `scient-${name}-seams.json`,
        JSON.stringify({
          ...f.manifest,
          schemaVersion: name === "skills" ? 1 : 2,
          [signals]: ["ScientFeature"],
        }),
      );
    }
    for (let i = 0; i < 130; i += 1) f.write(`product/${i}.ts`, "ScientFeature();\n");
    for (let i = 0; i < 200; i += 1) f.write(`.repos/reference/${i}.ts`, "ScientFeature();\n");
    const result = f.inspect(["--base", f.base], ["onboarding", "skills", "analysis", "latex"]);
    expect(result.referencePaths).toHaveLength(200);
    expect(result.changedPaths).toHaveLength(333);
    expect(result.stats.diffBatches).toBe(3);
    expect(result.stats.gitCommands).toBeLessThan(50);
    for (const check of result.checks) {
      expect(check.status).toBe("review-needed");
      expect(check.findings).toHaveLength(130);
      expect(check.findings.every((finding) => finding.message.includes(": product/"))).toBe(true);
    }
  });

  it("does not exclude product changes that reference the read-only snapshots", () => {
    const f = fixture();
    f.write("app.ts", 'import { ScientFeature } from "./.repos/reference/module";\n');
    expect(f.messages(f.inspect())).toContain(
      "Changed path is not classified in scient-onboarding-seams.json: app.ts",
    );
  });

  it("keeps binary and mode-only changes associated with the correct paths", () => {
    const f = fixture();
    f.write("binary.dat", "\0ScientFeature\0");
    f.write("unclassified.ts", "ScientFeature();\n");
    NodeFS.chmodSync(NodePath.join(f.cwd, "host.ts"), 0o755);
    const result = f.inspect();
    expect(result.changedPaths).toEqual(expect.arrayContaining(["binary.dat", "unclassified.ts"]));
    expect(f.messages(result)).toEqual([
      "Changed path is not classified in scient-onboarding-seams.json: unclassified.ts",
    ]);
  });

  it.each(["symlink-to-file", "file-to-symlink"])(
    "audits both halves of a %s change without shifting neighboring patches",
    (direction) => {
      const f = fixture();
      const path = "middle [type]\nchange.ts";
      const absolutePath = NodePath.join(f.cwd, path);
      if (direction === "symlink-to-file") NodeFS.symlinkSync("target.ts", absolutePath);
      else f.write(path, "ScientFeature();\n");
      const base = f.commit();
      NodeFS.unlinkSync(absolutePath);
      if (direction === "symlink-to-file") f.write(path, "ScientFeature();\n");
      else NodeFS.symlinkSync("target.ts", absolutePath);
      f.write("aaa.ts", "ScientFeature();\n");
      f.write("zzz.ts", "ScientFeature();\n");
      const head = f.commit();
      const result = f.inspect(["--base", base, "--head", head]);
      expect(result.checks[0].status).toBe("review-needed");
      expect(f.messages(result)).toEqual(
        ["aaa.ts", path, "zzz.ts"].map(
          (name) => `Changed path is not classified in scient-onboarding-seams.json: ${name}`,
        ),
      );
      expect(result.stats.diffBatches).toBe(1);
    },
  );

  it("uses the inspected snapshot's frozen upstream, not a newer remote-tracking branch", () => {
    const f = fixture();
    f.git("update-ref", "refs/remotes/upstream-verification/main", f.base);
    const result = f.inspect();
    expect(result.context.upstream).toBe(f.upstream);
    expect(result.checks[0].status).toBe("passed");
    expect(
      f.inspect(["--base", f.base, "--upstream-ref", "upstream-verification/main"]).checks[0]
        .status,
    ).toBe("review-needed");
  });

  it("reads committed manifests and mounts, not dirty working-tree replacements", () => {
    const f = fixture();
    f.write("host.ts", "export const host = true;\n");
    f.write("scient-onboarding-seams.json", "broken JSON");
    const committed = f.inspect(["--base", f.upstream, "--head", f.base]);
    expect(committed.context.head).toBe(f.base);
    expect(committed.checks[0].status).toBe("passed");
    expect(f.inspect().checks[0].status).toBe("unavailable");
  });

  it("does not let a working-tree repair hide a broken committed mount", () => {
    const f = fixture();
    f.write("host.ts", "export const host = true;\n");
    const broken = f.commit();
    f.write("host.ts", "export const ScientFeature = true;\n");
    expect(f.inspect(["--base", f.base, "--head", broken]).checks[0].status).toBe("review-needed");
    expect(f.inspect().checks[0].status).toBe("passed");
  });

  it("separates index and working-tree content without changing either", () => {
    const f = fixture();
    f.write("host.ts", "export const host = true;\n");
    f.git("add", "host.ts");
    f.write("host.ts", "export const ScientFeature = true;\n");
    const before = f.git("status", "--porcelain=v1");
    expect(f.inspect(["--base", f.base, "--snapshot", "index"]).checks[0].status).toBe(
      "review-needed",
    );
    expect(f.inspect().checks[0].status).toBe("passed");
    expect(f.git("status", "--porcelain=v1")).toBe(before);
    expect(f.git("show", ":host.ts")).toBe("export const host = true;");
  });

  it("audits deletions of unclassified integration code", () => {
    const f = fixture();
    f.write("forgotten.ts", "ScientFeature();\n");
    const before = f.commit();
    f.git("rm", "forgotten.ts");
    const result = f.inspect(["--base", before]);
    expect(result.changedPaths).toContain("forgotten.ts");
    expect(f.messages(result)).toContain(
      "Changed path is not classified in scient-onboarding-seams.json: forgotten.ts",
    );
  });

  it("reports deleted mounts and owned roots instead of treating deletion as success", () => {
    const f = fixture();
    f.git("rm", "host.ts", "owned/feature.ts");
    expect(f.messages(f.inspect())).toEqual(
      expect.arrayContaining(["Mount missing: host.ts", "Owned path missing: owned"]),
    );
  });

  it("allows a reviewed locator move without pinning the old component structure", () => {
    const f = fixture();
    f.write("host.ts", "export const host = true;\n");
    f.write("next-host.ts", "export const ScientFeature = true;\n");
    expect(f.inspect().checks[0].status).toBe("review-needed");
    f.manifest.upstreamMounts[0].path = "next-host.ts";
    f.saveManifest();
    expect(f.inspect().checks[0].status).toBe("passed");
    expect(f.inspect().checks[0].manifestChanged).toBe(true);
  });

  it("reports both sides of a rename, including a newly unclassified path", () => {
    const f = fixture();
    f.git("mv", "host.ts", "renamed host.ts");
    const result = f.inspect();
    expect(result.changedPaths).toEqual(expect.arrayContaining(["host.ts", "renamed host.ts"]));
    expect(f.messages(result)).toContain(
      "Changed path is not classified in scient-onboarding-seams.json: renamed host.ts",
    );
  });

  it("includes non-ignored untracked files, preserves literal filenames and changes its evidence tree after edits", () => {
    const f = fixture();
    const before = f.inspect();
    f.write("odd [name]\nfile.ts", "ScientFeature();\n");
    f.write(".gitignore", "ignored.ts\n");
    f.write("ignored.ts", "ScientFeature();\n");
    const after = f.inspect();
    expect(after.context.tree).not.toBe(before.context.tree);
    expect(after.changedPaths).toContain("odd [name]\nfile.ts");
    expect(after.changedPaths).not.toContain("ignored.ts");
    expect(after.checks[0].status).toBe("review-needed");
  });

  it("does not confuse inventory checks with changed-path coverage", () => {
    const f = fixture();
    f.write("unclassified.ts", "ScientFeature();\n");
    expect(f.inspect([]).coverage).toBe("inventory-only (no diff audited)");
    expect(f.inspect([]).checks[0].status).toBe("passed");
    expect(f.inspect().checks[0].status).toBe("review-needed");
  });

  it("includes an explicitly staged ignored file in the working snapshot", () => {
    const f = fixture();
    f.write(".gitignore", "ignored.ts\n");
    f.write("ignored.ts", "ScientFeature();\n");
    f.git("add", "--force", "ignored.ts");
    expect(f.inspect().changedPaths).toContain("ignored.ts");
    expect(f.inspect().checks[0].status).toBe("review-needed");
  });

  it.each([
    ["--base", "missing-base"],
    ["--base", "HEAD", "--head", "missing-head"],
    ["--upstream-ref", "missing-upstream"],
    ["--head", "HEAD"],
    ["--snapshot", "something"],
    ["--format", "typo"],
    ["--base", "HEAD", "--base", "HEAD"],
  ])("never passes when context cannot be established: %j", (...args) => {
    expect(fixture().inspect(args).checks[0].status).toBe("unavailable");
  });

  it("fails invalid ownership/path declarations without inspecting outside the repository", () => {
    const f = fixture();
    f.manifest.ownedRoots = ["../outside"];
    f.saveManifest();
    expect(f.inspect().checks[0].status).toBe("failed");
    f.manifest.ownedRoots = ["owned"];
    f.manifest.owner = "SomeoneElse";
    f.saveManifest();
    expect(f.inspect().checks[0].status).toBe("failed");
  });

  it("continues independent checks when a manifest is unavailable", () => {
    const f = fixture();
    const result = f.inspect(["--base", f.base], ["analysis", "onboarding"]);
    expect(result.checks.map((check) => check.status)).toEqual(["unavailable", "passed"]);
  });

  it("classifies anchored mounts in shared Scient-owned files without claiming them", () => {
    const f = fixture();
    f.write("shared/common.ts", "export const other = true;\nexport const ScientFeature = true;\n");
    expect(f.messages(f.inspect())).toContain(
      "Changed path is not classified in scient-onboarding-seams.json: shared/common.ts",
    );
    f.manifest.scientMounts = [
      { path: "shared/common.ts", anchor: "ScientFeature", purpose: "Mount the shared fixture" },
    ];
    f.saveManifest();
    expect(f.inspect().checks[0].status).toBe("passed");
    f.write("shared/common.ts", "export const other = true;\n");
    expect(f.messages(f.inspect())).toContain(
      "Scient mount shared/common.ts missing locator: ScientFeature",
    );
    f.manifest.scientMounts = [{ path: "next-host.ts", anchor: "nextHost" }];
    f.saveManifest();
    expect(f.messages(f.inspect())).toContain(
      "Scient mount exists upstream; use an upstream mount: next-host.ts",
    );
  });

  it("does not allow new integration code through a retired classification", () => {
    const f = fixture();
    f.manifest.upstreamMounts = [];
    f.saveManifest();
    f.write("host.ts", "export const ScientFeature = false;\n");
    expect(f.messages(f.inspect())).toContain(
      "Changed path is not classified in scient-onboarding-seams.json: host.ts",
    );
  });

  it("does not hide old diff signals when the manifest changes them", () => {
    const f = fixture();
    f.write("unclassified.ts", "ScientFeature();\n");
    const before = f.commit();
    f.manifest.onboardingDiffSignals = ["ReplacementFeature"];
    f.saveManifest();
    f.git("rm", "unclassified.ts");
    expect(f.inspect(["--base", before]).checks[0].status).toBe("review-needed");
  });

  it("retains filename and hunk evidence for unrefined signals", () => {
    const f = fixture();
    f.git("config", "diff.typescript.xfuncname", "^export function.*");
    f.write(".gitattributes", "*.ts diff=typescript\n");
    f.write("ordinary.ts", "export function ScientFeature() {\n  return 1;\n}\n");
    const before = f.commit();
    f.write("ordinary.ts", "export function ScientFeature() {\n  return 2;\n}\n");
    f.write("ScientFeature.ts", "export const unrelated = true;\n");
    expect(f.git("diff", "--unified=0", before, "--", "ordinary.ts")).toContain(
      "@@ -2 +2 @@ export function ScientFeature() {",
    );
    expect(f.messages(f.inspect(["--base", before]))).toEqual([
      "Changed path is not classified in scient-onboarding-seams.json: ScientFeature.ts",
      "Changed path is not classified in scient-onboarding-seams.json: ordinary.ts",
    ]);
  });

  it("distinguishes tunnel connector changes from the Extensions boundary", () => {
    const f = connectorFixture();
    const unrelated = {
      "apps/server/src/cloud/ConnectReachability.ts":
        "const connector = tunnel.readyConnections;\n",
      "apps/server/src/cloud/ManagedEndpointRuntime.ts": "cloudflared.inspectConnector();\n",
      "apps/server/src/cloud/managedTunnelStartup.ts": "// Wait for connector registration.\n",
      "infra/relay/src/environments/EnvironmentConnector.ts":
        "// MCP authorization contracts share this module.\nexport const ready = true;\n",
      "infra/relay/src/environments/ManagedEndpointProvider.ts":
        "// Recover connector registration.\n",
      "infra/relay/src/environments/endpointFailure.ts":
        "// Cloudflared 1033: no live connector.\n",
      "infra/relay/src/monitoring.ts": 'query("relay.environment_connector.connect");\n',
      "packages/contracts/src/environmentHttp.ts":
        '// Also contains MCP authorization contracts.\nconst tunnelStatus = "no_connector";\n',
      "packages/contracts/src/relay.ts": "// Cloudflare connector disconnected.\n",
    };
    for (const [path, source] of Object.entries(unrelated)) f.write(path, source);
    const result = f.inspect();
    expect(result.changedPaths).toEqual(expect.arrayContaining(Object.keys(unrelated)));
    expect(result.checks[0].status).toBe("passed");
  });

  it("keeps connector delivery and independent stronger signals classified", () => {
    const f = connectorFixture();
    const boundaries = {
      "delivery.ts": "deliver(mcp.connectors);\n",
      "session.ts": "export const config = { connectors: [] };\n",
      "types.ts": "export type McpProviderSessionConnector = { url: string };\n",
      "runtime.ts": "ConnectorRuntime.create();\n",
      "native.ts": "ServerProviderPlugin.register();\n",
    };
    for (const [path, source] of Object.entries(boundaries)) f.write(path, source);
    expect(f.messages(f.inspect())).toEqual(
      Object.keys(boundaries)
        .sort()
        .map((path) => `Changed path is not classified in scient-extensions-seams.json: ${path}`),
    );
  });

  it.each([
    { domain: "MCP", status: "review-needed" },
    { domain: "cloudflared", status: "passed" },
  ])(
    "preserves changed connector function ownership in the $domain domain",
    ({ domain, status }) => {
      const f = connectorFixture();
      f.git("config", "diff.typescript.xfuncname", "^export function.*");
      f.write(".gitattributes", "*.ts diff=typescript\n");
      const context = `// ${domain} delivery\nexport function connector() {\n`;
      f.write("delivery.ts", `${context}  return 1;\n}\n`);
      const before = f.commit();
      f.write("delivery.ts", `${context}  return 2;\n}\n`);
      expect(f.git("diff", "--unified=0", before, "--", "delivery.ts")).toContain(
        "@@ -3 +3 @@ export function connector() {",
      );
      expect(f.inspect(["--base", before]).checks[0].status).toBe(status);
    },
  );

  it.each(["+", "-"])("retains the %s source marker for refinement patterns", (marker) => {
    const f = connectorFixture();
    f.manifest.diffSignalRefinements = [
      {
        signal: "[Cc]onnectors?\\b",
        changed: `[${marker}]deliver\\(connector`,
        fileContext: "MCP",
      },
    ];
    f.saveManifest();
    const source = "// MCP delivery\ndeliver(connector.url);\n";
    if (marker === "-") f.write("delivery.ts", source);
    const before = f.commit();
    if (marker === "-") f.git("rm", "delivery.ts");
    else f.write("delivery.ts", source);
    expect(f.messages(f.inspect(["--base", before]))).toEqual([
      "Changed path is not classified in scient-extensions-seams.json: delivery.ts",
    ]);
  });

  it("requires the original signal even if a refinement's changed pattern is broader", () => {
    const f = connectorFixture();
    f.manifest.diffSignalRefinements = [{ signal: "[Cc]onnectors?\\b", changed: "Unrelated" }];
    f.saveManifest();
    f.write("unrelated.ts", "Unrelated();\n");
    expect(f.inspect().checks[0].status).toBe("passed");
  });

  it("recognizes connector-only edits through an unchanged MCP import", () => {
    const f = connectorFixture();
    const context = 'import { deliver } from "./mcp";\n\n';
    f.write("delivery.ts", `${context}deliver(connector.url);\n`);
    const before = f.commit();
    f.write("delivery.ts", `${context}deliver(connector.endpoint);\n`);
    expect(f.messages(f.inspect(["--base", before]))).toEqual([
      "Changed path is not classified in scient-extensions-seams.json: delivery.ts",
    ]);
  });

  it.each(["file", "namespace-and-usage"])(
    "recognizes removed connector code using base-only context: %s",
    (removal) => {
      const f = connectorFixture();
      f.write("delivery.ts", 'import { deliver } from "./mcp";\ndeliver(connector.url);\n');
      const before = f.commit();
      if (removal === "file") f.git("rm", "delivery.ts");
      else f.write("delivery.ts", "export const retired = true;\n");
      expect(f.messages(f.inspect(["--base", before]))).toEqual([
        "Changed path is not classified in scient-extensions-seams.json: delivery.ts",
      ]);
    },
  );

  it.each(["remove", "narrow", "remove-signal"])(
    "retains base refinement evidence when current rules %s it",
    (change) => {
      const f = connectorFixture();
      f.write("delivery.ts", 'import { deliver } from "./mcp";\ndeliver(connector.url);\n');
      const before = f.commit();
      if (change === "narrow")
        f.manifest.diffSignalRefinements = [
          { signal: "[Cc]onnectors?\\b", changed: "Replacement", fileContext: "NewNamespace" },
        ];
      else delete f.manifest.diffSignalRefinements;
      if (change === "remove-signal") f.manifest.extensionsDiffSignals = ["Replacement"];
      f.saveManifest();
      f.git("rm", "delivery.ts");
      expect(f.messages(f.inspect(["--base", before]))).toEqual([
        "Changed path is not classified in scient-extensions-seams.json: delivery.ts",
      ]);
    },
  );

  it.each(
    [
      null,
      {},
      [{ signal: "absent", changed: "connector" }],
      [{ signal: "[Cc]onnectors?\\b", changed: "" }],
      [{ signal: "[Cc]onnectors?\\b", changed: "connector", fileContext: false }],
      [{ signal: "[Cc]onnectors?\\b", changed: "connector", fileContex: "mcp" }],
      [{ signal: "[Cc]onnectors?\\b", changed: "[" }],
      [{ signal: "[Cc]onnectors?\\b", changed: "connector", fileContext: "[" }],
    ].map((rules) => ({ rules })),
  )("fails closed for an invalid refinement: $rules", ({ rules }) => {
    const f = connectorFixture();
    f.manifest.diffSignalRefinements = rules;
    f.saveManifest();
    expect(f.inspect().checks[0].status).toBe("unavailable");
  });

  it("refuses a conflicted local index but can still inspect an immutable committed candidate", () => {
    const f = fixture();
    f.git("checkout", "-b", "other");
    f.write("host.ts", "other\n");
    f.commit();
    f.git("checkout", "main");
    f.write("host.ts", "main\n");
    f.commit();
    expect(() => f.git("merge", "other")).toThrow();
    expect(f.inspect().checks[0].status).toBe("unavailable");
    expect(f.inspect(["--base", f.upstream, "--head", f.base]).checks[0].status).toBe("passed");
  });

  it.each(["onboarding", "skills", "analysis", "latex"])(
    "keeps the %s CLI independently usable with truthful exit status",
    (name) => {
      const f = fixture();
      const signals = name === "skills" ? "skillDiffSignals" : `${name}DiffSignals`;
      f.write(
        `scient-${name}-seams.json`,
        JSON.stringify({
          ...f.manifest,
          schemaVersion: name === "skills" ? 1 : 2,
          [signals]: ["ScientFeature"],
        }),
      );
      const script = new URL(`./verify-scient-${name}-seams.mjs`, import.meta.url);
      const run = () =>
        NodeChildProcess.spawnSync(
          process.execPath,
          [script.pathname, "--base", f.base, "--format", "json"],
          { cwd: f.cwd, encoding: "utf8" },
        );
      const good = run();
      expect(good.status).toBe(0);
      expect(JSON.parse(good.stdout).checks.map((check) => check.name)).toEqual([name]);
      f.write("host.ts", "missing\n");
      expect(run().status).toBe(1);
    },
  );
});

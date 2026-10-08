// @effect-diagnostics nodeBuiltinImport:off -- Exercises the workflow's Git publication against a disposable local remote.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import bundled from "../apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json" with { type: "json" };

const repository = NodePath.resolve(import.meta.dirname, "..");
const catalogPath = "apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json";
const branch = "automation/managed-runtime-catalog-v1";
const nextPatch = (version: string) =>
  version.replace(/\d+$/u, (patch) => String(Number(patch) + 1));

function git(cwd: string, ...args: string[]) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Real workflow, real promotion CLI, two independent Git writers; no GitHub or provider network. */
function exercisePublication(races: number) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-publication-race-"));
  try {
    const remote = NodePath.join(root, "remote.git");
    const source = NodePath.join(root, "source");
    const racer = NodePath.join(root, "racer");
    const runner = NodePath.join(root, "runner");
    NodeFS.mkdirSync(source);
    NodeFS.mkdirSync(NodePath.join(runner, "managed-runtime-catalog-candidate"), {
      recursive: true,
    });
    git(root, "init", "--bare", remote);
    git(source, "init", "-b", "main");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "user.name", "Fixture");
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(source, catalogPath)), { recursive: true });
    const current = structuredClone(bundled);
    current.providers.antigravityAcp.contractRevision = 1;
    current.providers.antigravityAcp.version = "1.1.1";
    NodeFS.writeFileSync(NodePath.join(source, catalogPath), JSON.stringify(current));
    git(source, "add", ".");
    git(source, "commit", "-m", "synthetic catalog");
    const sha = git(source, "rev-parse", "HEAD");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "HEAD:refs/heads/main", `HEAD:refs/heads/${branch}`);
    git(root, "clone", "--branch", branch, remote, racer);
    git(racer, "config", "user.email", "fixture@example.invalid");
    git(racer, "config", "user.name", "Other fixture writer");
    const candidate = structuredClone(current);
    candidate.providers.claudeAgent.version = nextPatch(current.providers.claudeAgent.version);
    NodeFS.writeFileSync(
      NodePath.join(runner, "managed-runtime-catalog-candidate/managed-runtime-catalog.json"),
      JSON.stringify(candidate),
    );
    const racedCatalog = structuredClone(current);
    racedCatalog.providers.droid.version = nextPatch(current.providers.droid.version);
    NodeFS.writeFileSync(NodePath.join(root, "raced.json"), JSON.stringify(racedCatalog));
    const workflow = parse(
      NodeFS.readFileSync(
        NodePath.join(repository, ".github/workflows/managed-provider-runtime-update-provider.yml"),
        "utf8",
      ),
    );
    const script = workflow.jobs.publish.steps.find(
      (step: { name: string }) => step.name === "Merge and publish the qualified provider",
    ).run;
    const shims = `
      race_count=0
      gh() { echo 1; }
      node() { shift; command "$NATIVE_NODE" "$PROMOTION_ENTRY" "$@"; }
      git() {
        if [[ "$*" == *" push origin HEAD:refs/heads/"* && "$race_count" -lt "$RACES" ]]; then
          race_count=$((race_count + 1))
          command git -C "$RACER" fetch origin "$CATALOG_BRANCH"
          command git -C "$RACER" reset --hard FETCH_HEAD
          cp "$RACED_CATALOG" "$RACER/$CATALOG_PATH"
          command git -C "$RACER" add "$CATALOG_PATH"
          command git -C "$RACER" commit --allow-empty -m "competing writer $race_count"
          command git -C "$RACER" push origin "HEAD:refs/heads/$CATALOG_BRANCH"
        fi
        command git "$@"
      }
    `;
    const result = NodeChildProcess.spawnSync("bash", ["-c", shims + script], {
      cwd: source,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PROVIDER: "claudeAgent",
        SOURCE_SHA: sha,
        APP_SLUG: "fixture",
        RUNNER_TEMP: runner,
        GITHUB_STEP_SUMMARY: NodePath.join(root, "summary"),
        CATALOG_BRANCH: branch,
        CATALOG_PATH: catalogPath,
        BUNDLED_CATALOG_PATH: catalogPath,
        RACER: racer,
        RACES: String(races),
        RACED_CATALOG: NodePath.join(root, "raced.json"),
        NATIVE_NODE: process.execPath,
        PROMOTION_ENTRY: NodePath.join(repository, "scripts/promote-managed-runtime-catalog.ts"),
      },
    });
    const published = JSON.parse(
      git(root, "--git-dir", remote, "show", `${branch}:${catalogPath}`),
    );
    return {
      result,
      current,
      candidate,
      racedCatalog,
      published,
      sourceHead: git(source, "rev-parse", "HEAD"),
      sha,
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("serialized provider publication", () => {
  it("remerges after two competing fast-forward pushes without losing a sibling or changing source policy", () => {
    const { result, candidate, racedCatalog, published, sourceHead, sha } = exercisePublication(2);
    expect(result.status, result.stderr).toBe(0);
    expect(published.providers.claudeAgent).toEqual(candidate.providers.claudeAgent);
    expect(published.providers.droid).toEqual(racedCatalog.providers.droid);
    expect(published.providers.antigravityAcp).toEqual(racedCatalog.providers.antigravityAcp);
    expect(sourceHead).toBe(sha);
  });
  it("stops after three competing pushes and leaves the failed provider unpublished", () => {
    const { result, current, racedCatalog, published } = exercisePublication(3);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("without a recoverable catalog race");
    expect(published.providers.claudeAgent).toEqual(current.providers.claudeAgent);
    expect(published.providers.droid).toEqual(racedCatalog.providers.droid);
  });
});

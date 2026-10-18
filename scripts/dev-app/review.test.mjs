import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  chooseProfile,
  createProfile,
  installFingerprint,
  installWatchdogVerdict,
  markProfileRun,
  parseReviewRef,
  profileIdForRef,
  pruneProfiles,
  readProfile,
  releaseLock,
  restoreProfileSnapshot,
  retireProfile,
  snapshotProfile,
  tryAcquireLock,
  validateProfileRoot,
} from "./review.mjs";
import { quoteWindowsArgument, scheduledTaskXml } from "./host.mjs";

const roots = [];
function tempDir() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-dev-app-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("parseReviewRef", () => {
  it("reads pull requests, commits and branches", () => {
    assert.deepEqual(parseReviewRef("#574"), { kind: "pr", number: 574, label: "#574" });
    assert.deepEqual(parseReviewRef("pr:12"), { kind: "pr", number: 12, label: "#12" });
    assert.equal(parseReviewRef("commit:57602d2544").kind, "commit");
    assert.equal(parseReviewRef("a".repeat(40)).kind, "commit");
    // A short hex word without the prefix stays a branch name.
    assert.deepEqual(parseReviewRef("deadbeef"), {
      kind: "branch",
      name: "deadbeef",
      label: "deadbeef",
    });
    assert.equal(parseReviewRef("branch:claude/x").name, "claude/x");
  });

  it("refuses names git could read as options or ranges", () => {
    for (const bad of ["", "-rf", "a..b", "x y", "main;rm"]) {
      assert.throws(() => parseReviewRef(bad));
    }
  });

  it("gives each reference its own filesystem-safe profile", () => {
    assert.equal(profileIdForRef(parseReviewRef("#5")), "pr-5");
    const a = profileIdForRef(parseReviewRef("feature/a"));
    const b = profileIdForRef(parseReviewRef("feature-a"));
    assert.match(a, /^branch-feature-a-[0-9a-f]{6}$/u);
    assert.notEqual(a, b);
  });
});

describe("locks", () => {
  it("takes over only a lock whose owner is gone", () => {
    const path = NodePath.join(tempDir(), "operation.lock");
    const first = { pid: 1, start: "a" };
    const second = { pid: 2, start: "b" };
    assert.isTrue(tryAcquireLock(path, first, { ownerState: () => "alive" }).acquired);
    assert.deepEqual(tryAcquireLock(path, second, { ownerState: () => "alive" }), {
      acquired: false,
      holder: first,
      state: "alive",
    });
    assert.equal(tryAcquireLock(path, second, { ownerState: () => "unknown" }).state, "unknown");
    assert.isTrue(tryAcquireLock(path, second, { ownerState: () => "gone" }).acquired);
    releaseLock(path, first);
    assert.isTrue(NodeFS.existsSync(path), "a former owner cannot release the new owner's lock");
    releaseLock(path, second);
    assert.isFalse(NodeFS.existsSync(path));
  });
});

describe("profiles", () => {
  const ref = parseReviewRef("#7");
  const isAncestor = (ancestor, descendant) => descendant.startsWith(ancestor);

  it("reuses a profile only while its reference moves forward", () => {
    const profiles = tempDir();
    assert.equal(
      chooseProfile({ profilesDir: profiles, ref, sha: "a1", isAncestor }).action,
      "create",
    );
    const profile = createProfile(profiles, { id: "pr-7", ref });
    markProfileRun(profile, "a1");
    assert.deepEqual(chooseProfile({ profilesDir: profiles, ref, sha: "a1b2", isAncestor }), {
      id: "pr-7",
      action: "reuse",
      previousSha: "a1",
    });
    assert.equal(
      chooseProfile({ profilesDir: profiles, ref, sha: "zz", isAncestor }).action,
      "replace",
    );
    assert.equal(
      chooseProfile({ profilesDir: profiles, ref, sha: "a1", fresh: true, isAncestor }).action,
      "replace",
    );
  });

  it("restores the state from before the latest upgrade", () => {
    const profiles = tempDir();
    const profile = createProfile(profiles, { id: "pr-7", ref });
    markProfileRun(profile, "old");
    NodeFS.writeFileSync(NodePath.join(profile.dir, "state.sqlite"), "before");
    snapshotProfile(profiles, "pr-7");
    markProfileRun(readProfile(profiles, "pr-7"), "new");
    NodeFS.writeFileSync(NodePath.join(profile.dir, "state.sqlite"), "after");

    assert.equal(restoreProfileSnapshot(profiles, "pr-7", 1), "old");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(profiles, "pr-7", "state.sqlite"), "utf8"),
      "before",
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(profiles, "pr-7.retired-1", "state.sqlite")));
  });

  it("prunes old profiles but never the active one", () => {
    const profiles = tempDir();
    for (let index = 0; index < 9; index += 1) {
      const id = `pr-${String(index)}`;
      const profile = createProfile(profiles, { id, ref: parseReviewRef(`#${String(index)}`) });
      markProfileRun(profile, "x", Date.UTC(2026, 0, 1 + index));
    }
    for (let index = 0; index < 4; index += 1)
      retireProfile(profiles, `pr-${String(index)}`, index);
    pruneProfiles(profiles, "pr-4");
    const left = NodeFS.readdirSync(profiles).toSorted();
    assert.include(left, "pr-4");
    assert.deepEqual(
      left.filter((name) => /^pr-\d$/u.test(name)),
      ["pr-4", "pr-5", "pr-6", "pr-7", "pr-8"],
    );
    assert.deepEqual(
      left.filter((name) => name.includes(".retired-")),
      ["pr-2.retired-2", "pr-3.retired-3"],
    );
  });

  it("accepts only an existing profile directly inside the profiles folder", () => {
    const profiles = tempDir();
    const profile = createProfile(profiles, { id: "pr-7", ref });
    assert.equal(validateProfileRoot(profiles, profile.dir), NodeFS.realpathSync(profile.dir));
    assert.isNull(validateProfileRoot(profiles, NodePath.join(profiles, "missing")));
    assert.isNull(validateProfileRoot(profiles, profiles));
    assert.isNull(validateProfileRoot(profiles, "relative/pr-7"));
    const nested = NodePath.join(profile.dir, "inner");
    NodeFS.mkdirSync(nested);
    assert.isNull(validateProfileRoot(profiles, nested));
  });
});

describe("install", () => {
  it("fingerprints committed install inputs and the runtime", () => {
    const base = { nodeVersion: "v24.0.0", arch: "x64", platform: "win32" };
    const lsFiles = "100644 aaa 0\tpnpm-lock.yaml\n100644 bbb 0\tpackage.json\n";
    const reordered = "100644 bbb 0\tpackage.json\n100644 aaa 0\tpnpm-lock.yaml\n";
    assert.equal(
      installFingerprint({ ...base, lsFiles }),
      installFingerprint({ ...base, lsFiles: reordered }),
    );
    assert.notEqual(
      installFingerprint({ ...base, lsFiles }),
      installFingerprint({ ...base, lsFiles, nodeVersion: "v24.1.0" }),
    );
    assert.notEqual(
      installFingerprint({ ...base, lsFiles }),
      installFingerprint({ ...base, lsFiles: lsFiles.replace("aaa", "ccc") }),
    );
  });

  it("stops a silent install and any install past its deadline", () => {
    const limits = { idleMs: 100, deadlineMs: 1_000, startedAt: 0 };
    assert.equal(installWatchdogVerdict({ ...limits, now: 50, lastOutputAt: 0 }), "running");
    assert.equal(installWatchdogVerdict({ ...limits, now: 150, lastOutputAt: 0 }), "stalled");
    assert.equal(installWatchdogVerdict({ ...limits, now: 1_000, lastOutputAt: 990 }), "deadline");
  });
});

describe("Windows launch", () => {
  it("quotes arguments the way CommandLineToArgvW reads them", () => {
    assert.equal(quoteWindowsArgument("plain"), "plain");
    assert.equal(quoteWindowsArgument("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
    assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteWindowsArgument("C:\\dir with space\\"), '"C:\\dir with space\\\\"');
    assert.equal(quoteWindowsArgument(""), '""');
  });

  it("registers an on-demand task with no run-time limit and no second copy", () => {
    const xml = scheduledTaskXml({
      userId: "LAB\\me",
      command: "C:\\Windows\\System32\\conhost.exe",
      args: '--headless "a & b"',
      workingDirectory: "C:\\Users\\me\\.scient-next\\scient-dev-stable",
      description: "test",
    });
    assert.include(xml, "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    assert.include(xml, "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    assert.include(xml, "<LogonType>InteractiveToken</LogonType>");
    assert.include(xml, "<RunLevel>LeastPrivilege</RunLevel>");
    assert.include(xml, "--headless &quot;a &amp; b&quot;");
    assert.notInclude(xml, "<Triggers>");
  });
});

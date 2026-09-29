import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";
import {
  claimColdHandoff,
  coldHandoffDirectory,
  processStartToken,
  takeApprovedHandoff,
  takeClaimedColdHandoff,
  writeApprovedHandoff,
  writeColdHandoff,
} from "./dev-cold-handoff.mjs";

const root = "/worktree/scient-desktop";
const role = "candidate";
const identity = { dev: "1", ino: "2", size: "3", mtimeNs: "4" };

function withState(run) {
  const stateRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-cold-handoff-"));
  try {
    return run(stateRoot);
  } finally {
    NodeFS.rmSync(stateRoot, { recursive: true, force: true });
  }
}

function write(stateRoot, files = [{ path: "/tmp/test.scic", identity, readOnly: false }]) {
  return writeColdHandoff({
    stateRoot,
    root,
    role,
    coldPid: 123,
    coldStart: "Mon Sep 29 12:00:00 2026",
    files,
    now: 1_000_000,
  });
}

describe("private cold conversation handoff", () => {
  it("claims once and consumes once without changing the existing state-root mode", () =>
    withState((stateRoot) => {
      NodeFS.chmodSync(stateRoot, 0o755);
      const { path } = write(stateRoot);
      assert.equal(NodeFS.statSync(stateRoot).mode & 0o777, 0o755);
      assert.equal(NodeFS.statSync(coldHandoffDirectory(stateRoot)).mode & 0o777, 0o700);
      assert.equal(NodeFS.statSync(path).mode & 0o777, 0o600);
      const claimed = claimColdHandoff({ path, stateRoot, root, role, now: 1_000_001 });
      assert.throws(() => claimColdHandoff({ path, stateRoot, root, role, now: 1_000_001 }));
      assert.deepEqual(
        takeClaimedColdHandoff({ path: claimed.path, stateRoot, root, role, now: 1_060_000 }).files,
        [{ path: "/tmp/test.scic", identity, readOnly: false }],
      );
      assert.throws(() =>
        takeClaimedColdHandoff({ path: claimed.path, stateRoot, root, role, now: 1_060_000 }),
      );
    }));

  it("rejects a symlink, public mode, wrong identity, and expired unclaimed receipt", () =>
    withState((stateRoot) => {
      const first = write(stateRoot);
      assert.throws(() =>
        claimColdHandoff({ path: first.path, stateRoot, root: "/other", role, now: 1_000_001 }),
      );
      const second = write(stateRoot);
      NodeFS.chmodSync(second.path, 0o644);
      assert.throws(() =>
        claimColdHandoff({ path: second.path, stateRoot, root, role, now: 1_000_001 }),
      );
      const third = write(stateRoot);
      assert.throws(() =>
        claimColdHandoff({ path: third.path, stateRoot, root, role, now: 1_046_000 }),
      );
      const fourth = write(stateRoot);
      const target = `${fourth.path}.target`;
      NodeFS.renameSync(fourth.path, target);
      NodeFS.symlinkSync(target, fourth.path);
      assert.throws(() =>
        claimColdHandoff({ path: fourth.path, stateRoot, root, role, now: 1_000_001 }),
      );
    }));

  it("requires decimal stat identity and writable import receipt", () =>
    withState((stateRoot) => {
      assert.throws(() =>
        write(stateRoot, [
          { path: "/tmp/test.scic", identity: { ...identity, ino: "-1" }, readOnly: false },
        ]),
      );
      assert.throws(() => write(stateRoot, [{ path: "/tmp/test.scic", identity, readOnly: true }]));
    }));

  it("gets a process start token from an injected inspector", () => {
    assert.equal(
      processStartToken(123, {
        spawnSync: () => ({ status: 0, stdout: " Mon Sep 29 12:00:00 2026 \n" }),
      }),
      "Mon Sep 29 12:00:00 2026",
    );
  });

  it("transfers accepted identities once to the supervised process", () =>
    withState((stateRoot) => {
      const files = [{ path: "/tmp/test.scic", identity, readOnly: false }];
      const path = writeApprovedHandoff({ stateRoot, root, role, files, now: 1_000_000 });
      assert.deepEqual(takeApprovedHandoff({ path, stateRoot, root, role, now: 1_060_000 }), files);
      assert.throws(() => takeApprovedHandoff({ path, stateRoot, root, role, now: 1_060_000 }));
      const wrongRole = writeApprovedHandoff({ stateRoot, root, role, files, now: 1_000_000 });
      assert.throws(() =>
        takeApprovedHandoff({ path: wrongRole, stateRoot, root, role: "stable", now: 1_060_000 }),
      );
    }));
});

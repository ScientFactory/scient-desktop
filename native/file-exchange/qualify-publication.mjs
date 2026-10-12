/* Run only against isolated, compiled helpers. No live workspace/profile is opened. */
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = new Map(
  process.argv.slice(2).map((value) => {
    const split = value.indexOf("=");
    assert(split > 0, "Use --name=value");
    return [value.slice(0, split), value.slice(split + 1)];
  }),
);
const helper = args.get("--helper");
const probe = args.get("--probe-helper");
assert(helper && path.isAbsolute(helper), "--helper must name the production helper");
if (probe) assert(path.isAbsolute(probe));
const unsupportedRoot = args.get("--unsupported-root");
if (unsupportedRoot)
  assert(
    path.isAbsolute(unsupportedRoot),
    "--unsupported-root must name an actual non-clone volume directory",
  );
const selection = args.get("--only") ?? "all";
assert(
  ["all", "changed", "previous"].includes(selection),
  "--only must be all, changed or previous",
);
const owned = new Set();
const evidence = [];
function launch(executable, arguments_, environment = {}, extraPipe = false) {
  const child = childProcess.spawn(executable, arguments_, {
    env: { ...process.env, ...environment },
    stdio: extraPipe ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  owned.add(child);
  const lines = [],
    waiters = [];
  let diagnostic = "";
  const retired = Promise.withResolvers();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => {
    diagnostic += data;
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(line));
    if (index < 0) lines.push(line);
    else {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(line);
    }
  });
  child.on("error", (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.on("close", (code, signal) => {
    owned.delete(child);
    const error = new Error(`Helper retired: code=${code} signal=${signal} stderr=${diagnostic}`);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
    retired.resolve({ code, signal, diagnostic });
  });
  return {
    child,
    retired: retired.promise,
    next: (predicate) => {
      const index = lines.findIndex(predicate);
      if (index >= 0) return Promise.resolve(lines.splice(index, 1)[0]);
      const deferred = Promise.withResolvers();
      waiters.push({ predicate, ...deferred });
      return deferred.promise;
    },
  };
}
async function run(executable, arguments_) {
  const process_ = launch(executable, arguments_);
  process_.child.stdin.end();
  const reply = await process_.next((line) => line.startsWith("{"));
  const exit = await process_.retired;
  assert.equal(exit.code, 0, exit.diagnostic);
  assert.equal(exit.signal, null);
  return JSON.parse(reply);
}
function operation(binding, kind, source, destination, authority = "strict-current-root") {
  return [
    "--protocol=1",
    kind,
    authority,
    binding.rootPath,
    binding.parentRelativePath,
    binding.recordPath,
    binding.root.dev,
    binding.root.ino,
    binding.parent.dev,
    binding.parent.ino,
    binding.record.dev,
    binding.record.ino,
    source,
    destination,
  ];
}
async function bind(executable, fixture, authority = "strict-current-root") {
  const result = await run(executable, [
    "--protocol=1",
    "bind",
    authority,
    fixture.root,
    "sub",
    fixture.record,
    "-",
    "-",
    "-",
    "-",
    "-",
    "-",
    "-",
    "-",
  ]);
  assert.equal(result.code, 0, JSON.stringify(result));
  return {
    rootPath: fixture.root,
    parentRelativePath: "sub",
    recordPath: fixture.record,
    ...result.binding,
  };
}
async function bindParent(executable, rootPath, parentRelativePath = ".") {
  const result = await run(executable, [
    "--directory=1",
    "bind",
    "strict-current-root",
    rootPath,
    parentRelativePath,
    "-",
    "-",
    "-",
    "-",
    "-",
  ]);
  assert.equal(result.code, 0, JSON.stringify(result));
  return { rootPath, parentRelativePath, ...result.binding };
}
function directoryOperation(binding, kind, name) {
  return [
    "--directory=1",
    kind,
    "strict-current-root",
    binding.rootPath,
    binding.parentRelativePath,
    binding.root.dev,
    binding.root.ino,
    binding.parent.dev,
    binding.parent.ino,
    name,
  ];
}
function leaseArguments(bindings, defaultMode = "exclusive") {
  return [
    "--lease=1",
    defaultMode,
    ...bindings.flatMap((binding) => [
      binding.rootPath,
      binding.parentRelativePath,
      binding.root.dev,
      binding.root.ino,
      binding.parent.dev,
      binding.parent.ino,
      binding.mode ?? defaultMode,
    ]),
  ];
}
function frame(arguments_) {
  const payload = Buffer.from(`${arguments_.join("\0")}\0`);
  const result = Buffer.alloc(payload.length + 4);
  result.writeUInt32BE(payload.length);
  payload.copy(result, 4);
  return result;
}
async function retireLease(lease) {
  lease.child.stdin.end(Buffer.alloc(4));
  assert.equal((await lease.retired).code, 0);
}
async function command(lease, arguments_) {
  lease.child.stdin.write(frame(arguments_));
  const result = JSON.parse(await lease.next((line) => line.includes('"outcome"')));
  const retired = JSON.parse(await lease.next((line) => line.includes('"commandExit"')));
  assert.equal(retired.commandExit, 0);
  assert.equal(retired.commandSignal, 0);
  assert.equal(retired.code, 0);
  return result;
}
async function fixture(body, base = os.tmpdir()) {
  const temporary = await fs.mkdtemp(path.join(base, "scient-publication-qualification-"));
  const canonical = await fs.realpath(temporary);
  const root = path.join(canonical, "anchor", "root");
  const record = path.join(canonical, "record");
  const outside = path.join(canonical, "outside");
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  await fs.mkdir(record, { mode: 0o700 });
  await fs.mkdir(outside);
  if (process.platform === "win32") {
    const account = childProcess.execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
    });
    const sid = account.match(/S-1-[\d-]+/u)?.[0];
    assert(sid, "Current test principal SID unavailable");
    childProcess.execFileSync(
      "icacls.exe",
      [
        record,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "/setowner",
        `*${sid}`,
      ],
      { stdio: "pipe" },
    );
  } else await fs.chmod(record, 0o700);
  try {
    await body({ temporary: canonical, root, record, outside });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
const deadline = setTimeout(() => {
  for (const child of owned) child.kill();
  process.exitCode = 1;
  console.error(
    "Qualification deadline exceeded; only owned synthetic helper processes were terminated.",
  );
}, 60000);
deadline.unref();
async function qualifyCreation() {
  const generic = await run(helper, ["--protocol=1", "capabilities"]);
  assert.equal(
    generic.atomicCreateMetadata,
    false,
    "Host inquiry cannot authorize an unspecified volume",
  );
  assert.equal(
    generic.atomicExchange,
    process.platform === "darwin" || process.platform === "linux",
  );
  assert.equal(generic.atomicPublicationMetadata, false);
  await fixture(async (f) => {
    const before = await fs.readdir(f.root);
    const rooted = await run(helper, ["--protocol=1", "capabilities", f.root]);
    assert.equal(typeof rooted.atomicCreateMetadata, "boolean");
    const recordGroup = (await fs.stat(f.record)).gid;
    const targetGroup = process.getgroups?.().find((group) => group !== recordGroup);
    if (process.platform === "darwin" && targetGroup !== undefined)
      await fs.chown(path.join(f.root, "sub"), process.getuid(), targetGroup);
    const missing = path.join(f.root, "missing-parent");
    const unavailable = await run(helper, ["--protocol=1", "capabilities", missing]);
    assert.equal(unavailable.atomicCreateMetadata, false);
    let linked = null;
    if (process.platform !== "win32") {
      await fs.symlink(f.root, path.join(f.outside, "root-link"));
      linked = await run(helper, [
        "--protocol=1",
        "capabilities",
        path.join(f.outside, "root-link"),
      ]);
      assert.equal(linked.atomicCreateMetadata, false);
    }
    assert.deepEqual(await fs.readdir(f.root), before);
    await assert.rejects(fs.stat(missing), { code: "ENOENT" });
    if (process.platform !== "darwin") assert.equal(rooted.atomicCreateMetadata, false);
    evidence.push({
      case: "root-volume-capability-is-read-only-fails-closed-before-parent-admission",
      rooted,
      unavailable,
      linked,
    });
    const authority = rooted.strictCurrentRoot ? "strict-current-root" : "bound-object";
    const binding = await bind(helper, f, authority);
    const staged = path.join(f.record, "stage");
    const target = path.join(f.root, "sub", "created");
    const complete = "complete C\n".repeat(65536);
    await fs.writeFile(staged, complete, { mode: 0o666 });
    const sourceBefore = await fs.stat(staged, { bigint: true });
    const created = await run(helper, operation(binding, "create", "stage", "created", authority));
    if (!rooted.atomicCreateMetadata) {
      assert.equal(created.outcome, "unchanged");
      assert.notEqual(created.code, 0);
      await assert.rejects(fs.stat(target), { code: "ENOENT" });
      assert.equal(await fs.readFile(staged, "utf8"), complete);
      assert.deepEqual(created.flush, {
        sourceFile: -1,
        destinationFile: -1,
        sourceDirectory: -1,
        destinationDirectory: -1,
      });
      evidence.push({
        case: "unqualified-volume-refuses-complete-create-without-fallback",
        created,
      });
      return;
    }
    assert.equal(created.outcome, "applied");
    assert.equal(created.code, 0, JSON.stringify(created));
    assert.equal(await fs.readFile(target, "utf8"), complete);
    assert.equal(await fs.readFile(staged, "utf8"), complete);
    assert.equal(created.sourceBefore.ino, String(sourceBefore.ino));
    assert.equal(created.sourceAfter.ino, created.sourceBefore.ino);
    assert.notEqual(created.destinationAfter.ino, created.sourceAfter.ino);
    const ordinary = path.join(f.root, "sub", "ordinary");
    await fs.writeFile(ordinary, complete, { mode: 0o666 });
    const actual = await fs.stat(target),
      normal = await fs.stat(ordinary);
    assert.equal(actual.mode & 0o777, normal.mode & 0o777);
    assert.equal(actual.uid, normal.uid);
    assert.equal(actual.gid, normal.gid);
    for (const value of Object.values(created.flush))
      assert.equal(value, 0, JSON.stringify(created));
    await fs.writeFile(target, "public later edit");
    assert.equal(
      await fs.readFile(staged, "utf8"),
      complete,
      "The public inode must not be a hard link to the journal stage",
    );
    for (const kind of ["file", "symlink", "directory"]) {
      const name = `occupied-${kind}`,
        occupied = path.join(f.root, "sub", name);
      if (kind === "file") await fs.writeFile(occupied, "outside B");
      else if (kind === "symlink") await fs.symlink(ordinary, occupied);
      else await fs.mkdir(occupied);
      const before = await fs.lstat(occupied);
      const refused = await run(helper, operation(binding, "create", "stage", name));
      assert.equal(refused.outcome, "unchanged");
      assert.notEqual(refused.code, 0);
      assert.equal((await fs.lstat(occupied)).ino, before.ino);
      if (kind === "file") assert.equal(await fs.readFile(occupied, "utf8"), "outside B");
      if (kind === "symlink") assert.equal(await fs.readlink(occupied), ordinary);
      if (kind === "directory") assert.deepEqual(await fs.readdir(occupied), []);
      assert.equal(await fs.readFile(staged, "utf8"), complete);
      assert.deepEqual(refused.flush, {
        sourceFile: -1,
        destinationFile: -1,
        sourceDirectory: -1,
        destinationDirectory: -1,
      });
      evidence.push({ case: `complete-create-occupied-${kind}-untouched`, refused });
    }
    await fs.symlink(staged, path.join(f.record, "stage-link"));
    const badSource = await run(helper, operation(binding, "create", "stage-link", "bad-source"));
    assert.equal(badSource.outcome, "unchanged");
    assert.notEqual(badSource.code, 0);
    await assert.rejects(fs.stat(path.join(f.root, "sub", "bad-source")), { code: "ENOENT" });
    evidence.push({
      case: "complete-create-distinct-inode-normal-mode-group-source-private-no-final-source-follow",
      sourceGroup: String(sourceBefore.gid),
      normalGroup: normal.gid,
      targetParentGroup: targetGroup ?? recordGroup,
      created,
      badSource,
    });
  });
  if (process.platform === "darwin") {
    await fixture(async (f) => {
      const rooted = await run(helper, ["--protocol=1", "capabilities", f.root]);
      if (!rooted.atomicCreateMetadata) return;
      const parent = path.join(f.root, "sub");
      childProcess.execFileSync("/bin/chmod", [
        "+a",
        "everyone deny read,file_inherit,only_inherit",
        parent,
      ]);
      const binding = await bind(helper, f);
      const complete = "ACL-complete C\n".repeat(4096);
      await fs.writeFile(path.join(f.record, "stage"), complete, { mode: 0o666 });
      const ordinary = path.join(parent, "ordinary");
      await fs.writeFile(ordinary, complete, { mode: 0o666 });
      const result = await run(helper, operation(binding, "create", "stage", "created"));
      assert.equal(result.outcome, "applied");
      assert.equal(result.code, 0, JSON.stringify(result));
      const target = path.join(parent, "created"),
        actual = await fs.stat(target),
        normal = await fs.stat(ordinary);
      assert.equal(actual.size, Buffer.byteLength(complete));
      assert.equal(actual.mode & 0o777, normal.mode & 0o777);
      assert.equal(actual.uid, normal.uid);
      assert.equal(actual.gid, normal.gid);
      const acl = childProcess.execFileSync("/bin/ls", ["-le", target], { encoding: "utf8" });
      assert(/everyone(?: inherited)? deny read/u.test(acl), acl);
      await assert.rejects(fs.readFile(target), { code: "EACCES" });
      await assert.rejects(fs.readFile(ordinary), { code: "EACCES" });
      assert.equal(
        result.flush.destinationFile,
        os.constants.errno.EACCES,
        "An applied clone with denied reopen needs durability attention, not fake success",
      );
      assert.equal(result.flush.sourceFile, 0);
      assert.equal(await fs.readFile(path.join(f.record, "stage"), "utf8"), complete);
      evidence.push({
        case: "complete-create-inherits-actual-parent-deny-acl-normal-group-mode-and-truthful-denied-flush",
        result,
      });
    });
    if (probe)
      for (const barrier of ["BOUND", "CREATED"])
        for (const relocation of ["parent", "root"])
          await fixture(async (f) => {
            const rooted = await run(probe, ["--protocol=1", "capabilities", f.root]);
            if (!rooted.atomicCreateMetadata) return;
            const binding = await bind(probe, f);
            const staged = path.join(f.record, "stage");
            await fs.writeFile(staged, "complete relocation C", { mode: 0o666 });
            const child = launch(probe, operation(binding, "create", "stage", "created"), {
              [barrier === "BOUND"
                ? "SCIENT_PUBLICATION_BARRIER"
                : "SCIENT_PUBLICATION_CREATE_BARRIER"]: "1",
            });
            await child.next((line) => line === barrier);
            const moved = path.join(f.outside, "moved");
            await fs.rename(relocation === "root" ? f.root : path.join(f.root, "sub"), moved);
            child.child.stdin.end("\n");
            const result = JSON.parse(await child.next((line) => line.includes('"outcome"')));
            assert.equal((await child.retired).code, 0);
            assert.notEqual(result.code, 0, "Changed current-root binding cannot be acknowledged");
            const outside = path.join(moved, ...(relocation === "root" ? ["sub"] : []), "created");
            if (barrier === "BOUND") {
              assert.equal(result.outcome, "unchanged");
              await assert.rejects(fs.stat(outside), { code: "ENOENT" });
              assert.deepEqual(result.flush, {
                sourceFile: -1,
                destinationFile: -1,
                sourceDirectory: -1,
                destinationDirectory: -1,
              });
            } else {
              assert.equal(result.outcome, "applied");
              assert.equal(await fs.readFile(outside, "utf8"), "complete relocation C");
              assert.notEqual(result.destinationAfter.ino, result.sourceAfter.ino);
              for (const value of Object.values(result.flush))
                assert(value >= 0, JSON.stringify(result));
            }
            assert.equal(await fs.readFile(staged, "utf8"), "complete relocation C");
            evidence.push({
              case: `complete-create-${barrier.toLowerCase()}-${relocation}-relocation`,
              result,
            });
          });
  }
  if (unsupportedRoot)
    await fixture(async (f) => {
      const rooted = await run(helper, ["--protocol=1", "capabilities", f.root]);
      assert.equal(
        rooted.atomicCreateMetadata,
        false,
        "--unsupported-root must be an actual unsupported volume",
      );
      const binding = await bind(
        helper,
        f,
        rooted.strictCurrentRoot ? "strict-current-root" : "bound-object",
      );
      await fs.writeFile(path.join(f.record, "stage"), "C", { mode: 0o666 });
      const refused = await run(
        helper,
        operation(
          binding,
          "create",
          "stage",
          "created",
          rooted.strictCurrentRoot ? "strict-current-root" : "bound-object",
        ),
      );
      assert.equal(refused.outcome, "unchanged");
      assert.notEqual(refused.code, 0);
      assert.deepEqual(await fs.readdir(path.join(f.root, "sub")), []);
      assert.equal(await fs.readFile(path.join(f.record, "stage"), "utf8"), "C");
      evidence.push({
        case: "actual-unsupported-volume-create-refuses-without-source-parent-admission",
        rooted,
        refused,
      });
    }, unsupportedRoot);
}
async function qualifyChanged(capabilities) {
  await fixture(async (f) => {
    const before = await fs.readdir(f.outside);
    const binding = await bindParent(helper, f.outside);
    assert.equal(binding.parent.type, "directory");
    assert.deepEqual(await fs.readdir(f.outside), before);
    evidence.push({ case: "read-only-parent-binding-needs-no-private-directory", binding });
  });
  await fixture(async (f) => {
    const binding = await bindParent(helper, f.temporary);
    const privatePath = path.join(f.temporary, "host-private");
    const result = await run(helper, directoryOperation(binding, "private-create", "host-private"));
    if (!capabilities.privateRetentionDirectory) {
      assert.equal(result.outcome, "unchanged");
      assert.notEqual(result.code, 0);
      await assert.rejects(fs.stat(privatePath), { code: "ENOENT" });
    } else {
      assert.equal(result.outcome, "applied");
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(result.destinationAfter.type, "directory");
      if (process.platform !== "win32")
        assert.equal((await fs.stat(privatePath)).mode & 0o777, 0o700);
      const again = await run(
        helper,
        directoryOperation(binding, "private-create", "host-private"),
      );
      assert.equal(again.outcome, "unchanged");
      assert.equal(again.code, 0);
      assert.equal(again.destinationAfter.ino, result.destinationAfter.ino);
    }
    const broad = path.join(f.temporary, "broad");
    await fs.mkdir(broad, { mode: 0o755 });
    if (process.platform !== "win32") await fs.chmod(broad, 0o755);
    const modeBefore = (await fs.stat(broad)).mode;
    const refused = await run(helper, directoryOperation(binding, "private-create", "broad"));
    assert.equal(refused.outcome, "unchanged");
    assert.notEqual(refused.code, 0);
    assert.equal((await fs.stat(broad)).mode, modeBefore);
    if (process.platform !== "win32") {
      await fs.symlink(f.outside, path.join(f.temporary, "private-link"));
      const linked = await run(
        helper,
        directoryOperation(binding, "private-create", "private-link"),
      );
      assert.equal(linked.outcome, "unchanged");
      assert.notEqual(linked.code, 0);
      assert.deepEqual(await fs.readdir(f.outside), []);
      if (process.platform === "darwin") {
        const aclDirectory = path.join(f.temporary, "private-mode-broad-acl");
        await fs.mkdir(aclDirectory, { mode: 0o700 });
        childProcess.execFileSync("/bin/chmod", ["+a", "everyone allow read", aclDirectory]);
        const before = childProcess.execFileSync("/bin/ls", ["-led", aclDirectory], {
          encoding: "utf8",
        });
        const aclRefused = await run(
          helper,
          directoryOperation(binding, "private-create", "private-mode-broad-acl"),
        );
        assert.equal(aclRefused.outcome, "unchanged");
        assert.notEqual(aclRefused.code, 0);
        assert.equal(
          childProcess.execFileSync("/bin/ls", ["-led", aclDirectory], { encoding: "utf8" }),
          before,
        );
        evidence.push({ case: "private-existing-broad-acl-is-refused-without-repair", aclRefused });
        const deniedDirectory = path.join(f.temporary, "private-child-deny");
        await fs.mkdir(deniedDirectory, { mode: 0o700 });
        childProcess.execFileSync("/bin/chmod", [
          "+a",
          "everyone deny read,file_inherit,only_inherit",
          deniedDirectory,
        ]);
        const denyBefore = childProcess.execFileSync("/bin/ls", ["-led", deniedDirectory], {
          encoding: "utf8",
        });
        const denyRefused = await run(
          helper,
          directoryOperation(binding, "private-create", "private-child-deny"),
        );
        assert.equal(denyRefused.outcome, "unchanged");
        assert.notEqual(denyRefused.code, 0);
        assert.equal(
          childProcess.execFileSync("/bin/ls", ["-led", deniedDirectory], { encoding: "utf8" }),
          denyBefore,
        );
        assert.deepEqual(await fs.readdir(deniedDirectory), []);
        evidence.push({
          case: "private-existing-child-deny-is-refused-before-journal-access-without-repair",
          denyRefused,
        });
        const inheritedParent = path.join(f.temporary, "broad-inherited-parent");
        await fs.mkdir(inheritedParent);
        childProcess.execFileSync("/bin/chmod", [
          "+a",
          "everyone allow read,file_inherit,directory_inherit",
          inheritedParent,
        ]);
        const inheritedBinding = await bindParent(helper, inheritedParent);
        const born = await run(
          helper,
          directoryOperation(inheritedBinding, "private-create", "journal"),
        );
        assert.equal(born.outcome, "applied");
        assert.equal(born.code, 0, JSON.stringify(born));
        const privateChild = path.join(inheritedParent, "journal");
        assert.equal((await fs.stat(privateChild)).mode & 0o777, 0o700);
        const privateAcl = childProcess.execFileSync("/bin/ls", ["-led", privateChild], {
          encoding: "utf8",
        });
        assert(!privateAcl.includes("everyone allow"), privateAcl);
        await fs.writeFile(path.join(privateChild, "owner-child"), "owner access");
        assert.equal(
          await fs.readFile(path.join(privateChild, "owner-child"), "utf8"),
          "owner access",
        );
        assert.equal(
          (await run(helper, directoryOperation(inheritedBinding, "private-create", "journal")))
            .code,
          0,
        );
        evidence.push({
          case: "private-directory-birth-is-owner-only-despite-broad-parent-inherited-acl",
          born,
        });
      }
      if (process.getuid?.() === 0) {
        const foreign = path.join(f.temporary, "foreign-owner");
        await fs.mkdir(foreign, { mode: 0o700 });
        await fs.chown(foreign, 1, 1);
        const ownerRefused = await run(
          helper,
          directoryOperation(binding, "private-create", "foreign-owner"),
        );
        assert.equal(ownerRefused.outcome, "unchanged");
        assert.notEqual(ownerRefused.code, 0);
        assert.equal((await fs.stat(foreign)).uid, 1);
        evidence.push({ case: "private-wrong-owner-refused-without-repair", ownerRefused });
      }
    }
    if (process.platform === "win32" && capabilities.privateRetentionDirectory) {
      const deniedDirectory = path.join(f.temporary, "private-child-deny");
      const born = await run(
        helper,
        directoryOperation(binding, "private-create", "private-child-deny"),
      );
      assert.equal(born.code, 0);
      childProcess.execFileSync("icacls.exe", [deniedDirectory, "/deny", "*S-1-1-0:(OI)(IO)(R)"], {
        stdio: "pipe",
      });
      const before = childProcess.execFileSync("icacls.exe", [deniedDirectory], {
        encoding: "utf8",
      });
      const refused = await run(
        helper,
        directoryOperation(binding, "private-create", "private-child-deny"),
      );
      assert.equal(refused.outcome, "unchanged");
      assert.notEqual(refused.code, 0);
      assert.equal(
        childProcess.execFileSync("icacls.exe", [deniedDirectory], { encoding: "utf8" }),
        before,
      );
      assert.deepEqual(await fs.readdir(deniedDirectory), []);
      evidence.push({
        case: "windows-private-existing-child-deny-refused-without-dacl-repair",
        refused,
      });
    }
    evidence.push({
      case: "private-provision-creates-missing-refuses-broad-and-final-link",
      result,
      refused,
    });
  });
  await fixture(async (f) => {
    const binding = await bindParent(helper, f.root, "sub");
    const created = await run(helper, directoryOperation(binding, "mkdir", "chapter"));
    if (!capabilities.sourceParentMkdir) {
      assert.equal(created.outcome, "unchanged");
      assert.notEqual(created.code, 0);
      await assert.rejects(fs.stat(path.join(f.root, "sub", "chapter")), { code: "ENOENT" });
    } else {
      assert.equal(created.outcome, "applied");
      assert.equal(created.code, 0);
      const child = await bindParent(helper, f.root, "sub/chapter");
      const nested = await run(helper, directoryOperation(child, "mkdir", "sections"));
      assert.equal(nested.outcome, "applied");
      assert.equal(nested.code, 0);
      const occupied = await run(helper, directoryOperation(binding, "mkdir", "chapter"));
      assert.equal(occupied.outcome, "unchanged");
      assert.notEqual(occupied.code, 0);
      assert.equal((await fs.readdir(path.join(f.root, "sub", "chapter"))).join(","), "sections");
    }
    evidence.push({ case: "authorized-missing-source-parent-mkdir-is-exclusive", created });
  });
  await fixture(async (f) => {
    const binding = await bind(
      helper,
      f,
      capabilities.strictCurrentRoot ? "strict-current-root" : "bound-object",
    );
    const target = path.join(f.root, "sub", "source"),
      staged = path.join(f.record, "stage");
    await fs.writeFile(target, "preflight A", { mode: 0o644 });
    await fs.writeFile(staged, "local C", { mode: 0o600 });
    if (capabilities.atomicExchange) {
      const copied = await run(helper, operation(binding, "metadata", "source", "stage"));
      assert.equal(copied.code, 0);
      assert.equal(copied.outcome, "applied");
      await fs.rename(target, path.join(f.root, "sub", "preflight"));
      await fs.writeFile(target, "late outside B", { mode: 0o600 });
      if (process.platform === "darwin") {
        childProcess.execFileSync("/usr/bin/xattr", [
          "-w",
          "com.scient.publication",
          "actual-displaced-B",
          target,
        ]);
        childProcess.execFileSync("/bin/chmod", ["+a", "everyone deny write", target]);
      }
      const published = await run(helper, operation(binding, "exchange", "stage", "source"));
      assert.equal(published.code, 0, JSON.stringify(published));
      assert.equal(published.outcome, "applied");
      assert.equal(await fs.readFile(target, "utf8"), "local C");
      assert.equal(await fs.readFile(staged, "utf8"), "late outside B");
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
      if (process.platform === "darwin") {
        assert.equal(
          childProcess
            .execFileSync("/usr/bin/xattr", ["-p", "com.scient.publication", target], {
              encoding: "utf8",
            })
            .trim(),
          "actual-displaced-B",
        );
        const acl = childProcess.execFileSync("/bin/ls", ["-le", target], { encoding: "utf8" });
        assert(acl.includes("everyone deny write"), acl);
      }
      evidence.push({
        case: "exchange-copies-observed-mode-acl-xattr-before-visibility",
        copied,
        published,
      });
    } else {
      const authority = capabilities.strictCurrentRoot ? "strict-current-root" : "bound-object";
      const refused = await run(
        helper,
        operation(binding, "exchange", "stage", "source", authority),
      );
      assert.equal(refused.outcome, "unchanged");
      assert.notEqual(refused.code, 0);
      assert.equal(await fs.readFile(target, "utf8"), "preflight A");
      assert.equal(await fs.readFile(staged, "utf8"), "local C");
      assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
      assert.equal((await fs.stat(staged)).mode & 0o777, 0o600);
      evidence.push({
        case: "missing-atomic-metadata-refuses-before-any-exchange",
        authority,
        refused,
      });
    }
  });
  await fixture(async (f) => {
    const binding = await bindParent(helper, f.root, "sub");
    if (!capabilities.sharedPublicationLease) {
      const lease = launch(helper, leaseArguments([{ ...binding, mode: "shared" }]));
      const refused = JSON.parse(await lease.next((line) => line.includes('"lease"')));
      assert.equal(refused.lease, "refused");
      assert.notEqual(refused.code, 0);
      assert.equal((await lease.retired).code, 0);
      evidence.push({ case: "unqualified-shared-coordination-is-explicitly-refused", refused });
      return;
    }
    const first = launch(helper, leaseArguments([{ ...binding, mode: "shared" }]));
    await first.next((line) => line.includes('"lease":"acquired"'));
    const second = launch(helper, leaseArguments([{ ...binding, mode: "shared" }]));
    await second.next((line) => line.includes('"lease":"acquired"'));
    await retireLease(second);
    await retireLease(first);
    const root = await bindParent(helper, f.root);
    const record = await bindParent(helper, f.record);
    const publisher = await bind(
      helper,
      f,
      capabilities.strictCurrentRoot ? "strict-current-root" : "bound-object",
    );
    const exclusive = launch(
      helper,
      leaseArguments([
        { ...root, mode: "shared" },
        { ...binding, mode: "shared" },
        { ...binding, mode: "exclusive" },
        { ...record, mode: "exclusive" },
      ]),
    );
    await exclusive.next((line) => line.includes('"lease":"acquired"'));
    if (probe) {
      const contender = launch(probe, leaseArguments([{ ...binding, mode: "shared" }]), {
        SCIENT_LEASE_TRY: "1",
      });
      const blocked = JSON.parse(await contender.next((line) => line.includes('"lease"')));
      assert.equal(blocked.lease, "refused");
      assert.notEqual(blocked.code, 0);
      assert.equal((await contender.retired).code, 0);
      evidence.push({
        case: "duplicate-parent-ex-dominates-sh-under-real-lock-contention",
        blocked,
      });
    }
    await fs.writeFile(path.join(f.record, "stage"), "owned C");
    const result = await command(
      exclusive,
      operation(
        publisher,
        "move",
        "stage",
        "published",
        capabilities.strictCurrentRoot ? "strict-current-root" : "bound-object",
      ),
    );
    assert.equal(result.code, 0);
    assert.equal(result.outcome, "applied");
    await retireLease(exclusive);
    const sharedOnly = launch(helper, leaseArguments([{ ...binding, mode: "shared" }]));
    await sharedOnly.next((line) => line.includes('"lease":"acquired"'));
    sharedOnly.child.stdin.write(frame(directoryOperation(binding, "mkdir", "forbidden")));
    const refused = JSON.parse(await sharedOnly.next((line) => line.includes('"lease":"refused"')));
    assert.notEqual(refused.code, 0);
    assert.equal((await sharedOnly.retired).code, 0);
    await assert.rejects(fs.stat(path.join(f.root, "sub", "forbidden")), { code: "ENOENT" });
    evidence.push({
      case: "per-binding-shared-concurrency-ex-strongest-and-sh-no-namespace-authority",
      result,
      refused,
    });
  });
  if (probe && capabilities.sharedPublicationLease)
    await fixture(async (f) => {
      const root = await bindParent(probe, f.root);
      const nested = await bindParent(probe, f.root, "sub");
      const outside = await bindParent(probe, f.outside);
      const volume = await bindParent(probe, path.parse(f.root).root);
      const first = launch(
        probe,
        leaseArguments([
          { ...volume, mode: "shared" },
          { ...root, mode: "exclusive" },
        ]),
      );
      await first.next((line) => line.includes('"lease":"acquired"'));
      const unrelated = launch(
        probe,
        leaseArguments([
          { ...volume, mode: "shared" },
          { ...outside, mode: "exclusive" },
        ]),
      );
      await unrelated.next((line) => line.includes('"lease":"acquired"'));
      const contender = launch(
        probe,
        leaseArguments([
          { ...volume, mode: "shared" },
          { ...root, mode: "shared" },
          { ...nested, mode: "exclusive" },
        ]),
        { SCIENT_LEASE_TRY: "1" },
      );
      const blocked = JSON.parse(await contender.next((line) => line.includes('"lease"')));
      assert.equal(blocked.lease, "refused");
      assert.notEqual(blocked.code, 0);
      assert.equal((await contender.retired).code, 0);
      const writer = launch(
        probe,
        leaseArguments([
          { ...volume, mode: "shared" },
          { ...root, mode: "shared" },
          { ...nested, mode: "exclusive" },
        ]),
        { SCIENT_LEASE_PROBE: "1" },
      );
      await writer.next((line) => line === "LEASE_WAIT");
      await retireLease(first);
      await writer.next((line) => line.includes('"lease":"acquired"'));
      await retireLease(writer);
      await retireLease(unrelated);
      evidence.push({ case: "root-ex-fence-blocks-nested-writer-without-global-volume-ex" });
    });
  if (probe && capabilities.sourceParentMkdir)
    await fixture(async (f) => {
      const binding = await bindParent(probe, f.root, "sub");
      const child = launch(probe, directoryOperation(binding, "mkdir", "chapter"), {
        SCIENT_PUBLICATION_BARRIER: "1",
      });
      await child.next((line) => line === "BOUND");
      if (process.platform === "win32")
        await assert.rejects(fs.rename(path.join(f.root, "sub"), path.join(f.outside, "moved")));
      else await fs.rename(path.join(f.root, "sub"), path.join(f.outside, "moved"));
      child.child.stdin.end("\n");
      const result = JSON.parse(await child.next((line) => line.includes('"outcome"')));
      assert.equal((await child.retired).code, 0);
      if (process.platform === "win32") assert.equal(result.outcome, "applied");
      else {
        assert.equal(result.outcome, "unchanged");
        assert.notEqual(result.code, 0);
        await assert.rejects(fs.stat(path.join(f.outside, "moved", "chapter")), { code: "ENOENT" });
      }
      evidence.push({
        case: "source-parent-mkdir-relocation-cannot-create-outside-authority",
        result,
      });
    });
  if (probe && capabilities.atomicPublicationMetadata && process.platform === "darwin")
    for (const relocation of ["parent", "root"])
      await fixture(async (f) => {
        const binding = await bind(probe, f);
        const target = path.join(f.root, "sub", "source");
        await fs.writeFile(target, "actual displaced B", { mode: 0o600 });
        await fs.writeFile(path.join(f.record, "stage"), "local C", { mode: 0o644 });
        const child = launch(probe, operation(binding, "exchange", "stage", "source"), {
          SCIENT_PUBLICATION_METADATA_BARRIER: "1",
        });
        await child.next((line) => line === "EXCHANGED");
        const moved = path.join(f.outside, "moved");
        await fs.rename(relocation === "parent" ? path.dirname(target) : f.root, moved);
        const outsideTarget = path.join(moved, ...(relocation === "root" ? ["sub"] : []), "source");
        const mode = (await fs.stat(outsideTarget)).mode & 0o777;
        child.child.stdin.end("\n");
        const result = JSON.parse(await child.next((line) => line.includes('"outcome"')));
        assert.equal((await child.retired).code, 0);
        assert.equal(result.outcome, "applied");
        assert.notEqual(result.code, 0);
        assert.equal((await fs.stat(outsideTarget)).mode & 0o777, mode);
        assert.equal(await fs.readFile(outsideTarget, "utf8"), "local C");
        assert.equal(await fs.readFile(path.join(f.record, "stage"), "utf8"), "actual displaced B");
        evidence.push({
          case: `post-exchange-${relocation}-relocation-denies-metadata-write`,
          result,
        });
      });
}
try {
  const capabilities = await run(helper, ["--protocol=1", "capabilities"]);
  evidence.push({ case: "capabilities", ...capabilities });
  assert.equal(capabilities.publicationLease, true);
  if (selection !== "previous") await qualifyChanged(capabilities);
  if (selection !== "previous") await qualifyCreation();
  if (selection !== "changed") {
    if (!capabilities.strictCurrentRoot) {
      await fixture(async (f) => {
        await fs.writeFile(path.join(f.root, "sub", "source"), "A");
        const refused = await run(helper, [
          "--protocol=1",
          "capture",
          "strict-current-root",
          f.root,
          "sub",
          f.record,
          "-",
          "-",
          "-",
          "-",
          "-",
          "-",
          "source",
          "retained",
        ]);
        assert.equal(refused.outcome, "unchanged");
        assert.notEqual(refused.code, 0);
        assert.equal(await fs.readFile(path.join(f.root, "sub", "source"), "utf8"), "A");
        evidence.push({
          case: "strict-policy-unavailable-refuses-before-capture",
          result: refused,
        });
      });
      throw new Error(
        "Strict native authority unavailable on this host; no product fallback is permitted.",
      );
    }
    await fixture(async (f) => {
      const binding = await bind(helper, f);
      const target = path.join(f.root, "sub", "manuscript");
      await fs.writeFile(target, "late outside B", { mode: 0o600 });
      await fs.writeFile(path.join(f.record, "stage"), "local C", { mode: 0o600 });
      const writer = await fs.open(target, "r+");
      try {
        const result = await run(helper, operation(binding, "exchange", "stage", "manuscript"));
        if (!capabilities.atomicExchange) {
          assert.equal(result.outcome, "unchanged");
          assert.notEqual(result.code, 0);
          assert.equal(await fs.readFile(target, "utf8"), "late outside B");
          assert.equal(await fs.readFile(path.join(f.record, "stage"), "utf8"), "local C");
          evidence.push({
            case: "atomic-replacement-unavailable-refuses-before-displacement",
            result,
          });
        } else {
          assert.equal(result.outcome, "applied");
          assert.equal(result.code, 0);
          assert.equal(await fs.readFile(target, "utf8"), "local C");
          assert.equal(await fs.readFile(path.join(f.record, "stage"), "utf8"), "late outside B");
          await writer.write("held-writer D", 0, "utf8");
          assert(
            (await fs.readFile(path.join(f.record, "stage"), "utf8")).startsWith("held-writer D"),
          );
          assert.equal(await fs.readFile(target, "utf8"), "local C");
          if (process.platform !== "win32")
            assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
          evidence.push({ case: "exchange-retains-actual-entry-and-held-writer", result });
        }
      } finally {
        await writer.close();
      }
    });
    await fixture(async (f) => {
      const binding = await bind(helper, f);
      const source = path.join(f.root, "sub", "source");
      await fs.writeFile(source, "outside B");
      await fs.writeFile(path.join(f.record, "occupied"), "retained A");
      const refused = await run(helper, operation(binding, "capture", "source", "occupied"));
      assert.equal(refused.outcome, "unchanged");
      assert.notEqual(refused.code, 0);
      assert.equal(await fs.readFile(source, "utf8"), "outside B");
      assert.equal(await fs.readFile(path.join(f.record, "occupied"), "utf8"), "retained A");
      const captured = await run(helper, operation(binding, "capture", "source", "captured"));
      assert.equal(captured.outcome, "applied");
      assert.equal(captured.code, 0);
      await fs.writeFile(source, "newer C");
      const restore = await run(helper, operation(binding, "restore", "captured", "source"));
      assert.equal(restore.outcome, "unchanged");
      assert.notEqual(restore.code, 0);
      assert.equal(await fs.readFile(source, "utf8"), "newer C");
      assert.equal(await fs.readFile(path.join(f.record, "captured"), "utf8"), "outside B");
      const linked = await run(helper, operation(binding, "link", "captured", "destination"));
      assert.equal(linked.outcome, "applied");
      assert.equal(linked.code, 0);
      assert.equal(linked.sourceAfter.ino, linked.destinationAfter.ino);
      await fs.writeFile(path.join(f.root, "sub", "destination"), "descriptor edit E");
      assert.equal(await fs.readFile(path.join(f.record, "captured"), "utf8"), "descriptor edit E");
      const blockedLink = await run(helper, operation(binding, "link", "occupied", "destination"));
      assert.equal(blockedLink.outcome, "unchanged");
      assert.notEqual(blockedLink.code, 0);
      const installed = await run(helper, operation(binding, "move", "occupied", "installed"));
      assert.equal(installed.outcome, "applied");
      assert.equal(installed.code, 0);
      assert.equal(await fs.readFile(path.join(f.root, "sub", "installed"), "utf8"), "retained A");
      const restored = await run(helper, operation(binding, "restore", "captured", "restored"));
      assert.equal(restored.outcome, "applied");
      assert.equal(restored.code, 0);
      assert.equal(
        await fs.readFile(path.join(f.root, "sub", "restored"), "utf8"),
        "descriptor edit E",
      );
      evidence.push({
        case: "capture-exclusivity-occupied-restoration-hardlink-and-move",
        captured,
        restore,
        linked,
        installed,
        restored,
      });
    });
    if (process.platform !== "win32")
      await fixture(async (f) => {
        const binding = await bind(helper, f);
        const referent = path.join(f.outside, "referent");
        await fs.writeFile(referent, "outside must survive");
        await fs.symlink(referent, path.join(f.root, "sub", "late:link"));
        const captured = await run(
          helper,
          operation(binding, "capture", "late:link", "retained:link"),
        );
        assert.equal(captured.outcome, "applied");
        assert.equal(captured.code, 0);
        assert.equal(captured.destinationAfter.type, "symlink");
        assert.equal(await fs.readlink(path.join(f.record, "retained:link")), referent);
        assert.equal(await fs.readFile(referent, "utf8"), "outside must survive");
        evidence.push({ case: "captures-late-final-symlink-without-following-referent", captured });
      });
    await fixture(async (f) => {
      const binding = await bind(helper, f);
      await fs.writeFile(path.join(f.root, "sub", "source"), "A");
      await fs.rename(path.join(f.root, "sub"), path.join(f.outside, "old-parent"));
      await fs.mkdir(path.join(f.root, "sub"));
      await fs.writeFile(path.join(f.root, "sub", "source"), "replacement B");
      const refused = await run(helper, operation(binding, "capture", "source", "captured"));
      assert.equal(refused.outcome, "unchanged");
      assert.notEqual(refused.code, 0);
      assert.equal(await fs.readFile(path.join(f.root, "sub", "source"), "utf8"), "replacement B");
      evidence.push({ case: "stale-parent-identity-refuses-before-capture", refused });
    });
    if (probe) {
      for (const kind of capabilities.atomicExchange
        ? ["capture", "exchange", "move", "link"]
        : ["capture", "move", "link"])
        await fixture(async (f) => {
          const binding = await bind(probe, f);
          await fs.writeFile(path.join(f.root, "sub", "source"), "outside B");
          await fs.writeFile(path.join(f.record, "stage"), "local C");
          const process_ = launch(
            probe,
            operation(
              binding,
              kind,
              kind === "capture" ? "source" : "stage",
              kind === "exchange" ? "source" : "published",
            ),
            { SCIENT_PUBLICATION_BARRIER: "1" },
          );
          await process_.next((line) => line === "BOUND");
          if (process.platform === "win32") {
            await assert.rejects(fs.rename(path.join(f.root, "sub"), path.join(f.outside, "sub")));
          } else await fs.rename(path.join(f.root, "sub"), path.join(f.outside, "sub"));
          process_.child.stdin.end("\n");
          const result = JSON.parse(await process_.next((line) => line.startsWith("{")));
          assert.equal((await process_.retired).code, 0);
          if (process.platform !== "win32") {
            assert.equal(result.outcome, "unchanged");
            assert.notEqual(result.code, 0);
            assert.equal(
              await fs.readFile(path.join(f.outside, "sub", "source"), "utf8"),
              "outside B",
            );
            assert.equal(await fs.readFile(path.join(f.record, "stage"), "utf8"), "local C");
          } else {
            assert.equal(result.outcome, "applied");
            assert.equal(result.code, 0);
          }
          evidence.push({ case: `held-descendant-relocation-${kind}`, result });
        });
      for (const relocation of ["root", "ancestor", "root-replacement"])
        await fixture(async (f) => {
          const binding = await bind(probe, f);
          await fs.writeFile(path.join(f.root, "sub", "source"), "authorized A");
          const process_ = launch(probe, operation(binding, "capture", "source", "captured"), {
            SCIENT_PUBLICATION_BARRIER: "1",
          });
          await process_.next((line) => line === "BOUND");
          const source = relocation === "ancestor" ? path.dirname(f.root) : f.root;
          const moved = path.join(f.outside, "moved");
          if (process.platform === "win32") await assert.rejects(fs.rename(source, moved));
          else {
            await fs.rename(source, moved);
            if (relocation === "root-replacement") {
              await fs.mkdir(path.join(f.root, "sub"), { recursive: true });
              await fs.writeFile(path.join(f.root, "sub", "source"), "foreign B");
            }
          }
          process_.child.stdin.end("\n");
          const result = JSON.parse(await process_.next((line) => line.startsWith("{")));
          assert.equal((await process_.retired).code, 0);
          if (process.platform === "darwin") {
            assert.equal(result.outcome, "unchanged");
            assert.notEqual(result.code, 0);
          } else if (process.platform === "linux") {
            // Landlock binds authority to the original root object, but changed path binding cannot acknowledge.
            assert.equal(result.outcome, "applied");
            assert.notEqual(result.code, 0);
            assert.equal(
              await fs.readFile(path.join(f.record, "captured"), "utf8"),
              "authorized A",
            );
            if (relocation === "root-replacement")
              assert.equal(
                await fs.readFile(path.join(f.root, "sub", "source"), "utf8"),
                "foreign B",
              );
          } else {
            assert.equal(result.outcome, "applied");
            assert.equal(result.code, 0);
          }
          evidence.push({ case: `authorized-${relocation}-relocation`, result });
        });
      if (capabilities.sharedPublicationLease)
        await fixture(async (f) => {
          const binding = await bind(probe, f);
          const leaseArguments = [
            "--lease=1",
            "exclusive",
            f.root,
            "sub",
            binding.root.dev,
            binding.root.ino,
            binding.parent.dev,
            binding.parent.ino,
            "exclusive",
          ];
          const first = launch(probe, leaseArguments);
          await first.next((line) => line.includes('"lease":"acquired"'));
          // Duplicate/nested-root aliases must converge to the same actual parent identity lock.
          const second = launch(
            probe,
            [
              "--lease=1",
              "shared",
              path.join(f.root, "sub"),
              ".",
              binding.parent.dev,
              binding.parent.ino,
              binding.parent.dev,
              binding.parent.ino,
              "shared",
            ],
            { SCIENT_LEASE_PROBE: "1" },
          );
          await second.next((line) => line === "LEASE_WAIT");
          first.child.stdin.end(Buffer.alloc(4));
          assert.equal((await first.retired).code, 0);
          await second.next((line) => line.includes('"lease":"acquired"'));
          second.child.stdin.end(Buffer.alloc(4));
          assert.equal((await second.retired).code, 0);
          evidence.push({ case: "cross-process-nested-root-identity-lease-serialization" });
        });
      if (process.platform !== "win32")
        await fixture(async (f) => {
          const binding = await bind(probe, f);
          await fs.writeFile(path.join(f.record, "stage"), "owned C");
          const leaseArguments = [
            "--lease=1",
            "exclusive",
            f.root,
            "sub",
            binding.root.dev,
            binding.root.ino,
            binding.parent.dev,
            binding.parent.ino,
            "exclusive",
            f.record,
            ".",
            binding.record.dev,
            binding.record.ino,
            binding.record.dev,
            binding.record.ino,
            "exclusive",
          ];
          const owner = launch(
            probe,
            leaseArguments,
            { SCIENT_PUBLICATION_BARRIER: "1", SCIENT_PUBLICATION_BARRIER_FD3: "1" },
            true,
          );
          await owner.next((line) => line.includes('"lease":"acquired"'));
          const payload = Buffer.from(
            `${operation(binding, "move", "stage", "published").join("\0")}\0`,
          );
          const frame = Buffer.alloc(payload.length + 4);
          frame.writeUInt32BE(payload.length);
          payload.copy(frame, 4);
          owner.child.stdin.write(frame);
          await owner.next((line) => line === "BOUND");
          owner.child.kill("SIGKILL");
          const successor = launch(probe, leaseArguments, { SCIENT_LEASE_PROBE: "1" });
          await successor.next((line) => line === "LEASE_WAIT");
          owner.child.stdio[3].end("\n");
          await owner.retired; // close waits the inherited stdout pipe until the actual writer exits.
          await successor.next((line) => line.includes('"lease":"acquired"'));
          assert.equal(await fs.readFile(path.join(f.root, "sub", "published"), "utf8"), "owned C");
          successor.child.stdin.end(Buffer.alloc(4));
          assert.equal((await successor.retired).code, 0);
          evidence.push({ case: "holder-sigkill-does-not-retire-inherited-native-writer-lock" });
        });
    }
  }
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        observations: evidence,
        gaps: [
          ...(probe ? [] : ["Relocation and retirement probes require --probe-helper."]),
          ...(process.platform === "win32"
            ? [
                "Atomic replace-and-retain is unqualified and refused; Windows normal-save cutover remains blocked.",
                "Reparse/junction, DACL/ADS and directory-flush qualification remains required.",
              ]
            : []),
          ...(process.platform === "linux"
            ? [
                "Landlock root-object authority does not enforce current-root pathname relocation.",
                "Landlock does not constrain post-exchange metadata syscalls; ordinary publication is refused before displacement.",
              ]
            : []),
          ...(capabilities.sharedPublicationLease
            ? []
            : [
                "Windows cross-process SH coordination is unqualified and refused; EX mutex is not relabelled SH.",
              ]),
          ...(capabilities.atomicPublicationMetadata
            ? []
            : [
                "Atomic exchange preserves observed metadata; independent concurrent metadata changes are outside its serialization boundary.",
              ]),
          ...(unsupportedRoot
            ? []
            : [
                "Actual unsupported clone-volume refusal requires --unsupported-root on a separately mounted non-clone volume.",
              ]),
          "Supported-volume/fsync, cross-volume, storage-full and power-loss qualification remains required.",
          ...(process.getuid?.() === 0
            ? []
            : [
                "Wrong-owner private-directory qualification requires an isolated privileged fixture host.",
              ]),
        ],
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(deadline);
  for (const child of owned) child.kill();
  await Promise.all(
    [...owned].map((child) => new Promise((resolve) => child.once("close", resolve))),
  );
}

/* Run only against isolated, compiled helpers. No live workspace/profile is opened. */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const args = new Map(
  process.argv.slice(2).map((value) => {
    const split = value.indexOf("=");
    NodeAssert.ok(split > 0, "Use --name=value");
    return [value.slice(0, split), value.slice(split + 1)];
  }),
);
const helper = args.get("--helper");
const probe = args.get("--probe-helper");
NodeAssert.ok(helper && NodePath.isAbsolute(helper), "--helper must name the production helper");
if (probe) NodeAssert.ok(NodePath.isAbsolute(probe));
const unsupportedRoot = args.get("--unsupported-root");
if (unsupportedRoot)
  NodeAssert.ok(
    NodePath.isAbsolute(unsupportedRoot),
    "--unsupported-root must name an actual non-clone volume directory",
  );
const selection = args.get("--only") ?? "all";
NodeAssert.ok(
  ["all", "changed", "previous"].includes(selection),
  "--only must be all, changed or previous",
);
const owned = new Set();
const evidence = [];
function launch(executable, arguments_, environment = {}, extraPipe = false) {
  const child = NodeChildProcess.spawn(executable, arguments_, {
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
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
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
  NodeAssert.equal(exit.code, 0, exit.diagnostic);
  NodeAssert.equal(exit.signal, null);
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
  NodeAssert.equal(result.code, 0, JSON.stringify(result));
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
  NodeAssert.equal(result.code, 0, JSON.stringify(result));
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
  NodeAssert.equal((await lease.retired).code, 0);
}
async function command(lease, arguments_) {
  lease.child.stdin.write(frame(arguments_));
  const result = JSON.parse(await lease.next((line) => line.includes('"outcome"')));
  const retired = JSON.parse(await lease.next((line) => line.includes('"commandExit"')));
  NodeAssert.equal(retired.commandExit, 0);
  NodeAssert.equal(retired.commandSignal, 0);
  NodeAssert.equal(retired.code, 0);
  return result;
}
async function fixture(body, base = NodeOS.tmpdir()) {
  const temporary = await NodeFSP.mkdtemp(NodePath.join(base, "scient-publication-qualification-"));
  const canonical = await NodeFSP.realpath(temporary);
  const root = NodePath.join(canonical, "anchor", "root");
  const record = NodePath.join(canonical, "record");
  const outside = NodePath.join(canonical, "outside");
  await NodeFSP.mkdir(NodePath.join(root, "sub"), { recursive: true });
  await NodeFSP.mkdir(record, { mode: 0o700 });
  await NodeFSP.mkdir(outside);
  if (NodeOS.platform() === "win32") {
    const account = NodeChildProcess.execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
    });
    const sid = account.match(/S-1-[\d-]+/u)?.[0];
    NodeAssert.ok(sid, "Current test principal SID unavailable");
    NodeChildProcess.execFileSync(
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
  } else await NodeFSP.chmod(record, 0o700);
  try {
    await body({ temporary: canonical, root, record, outside });
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
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
  NodeAssert.equal(
    generic.atomicCreateMetadata,
    false,
    "Host inquiry cannot authorize an unspecified volume",
  );
  NodeAssert.equal(
    generic.atomicExchange,
    NodeOS.platform() === "darwin" || NodeOS.platform() === "linux",
  );
  NodeAssert.equal(generic.atomicPublicationMetadata, false);
  await fixture(async (f) => {
    const before = await NodeFSP.readdir(f.root);
    const rooted = await run(helper, ["--protocol=1", "capabilities", f.root]);
    NodeAssert.equal(typeof rooted.atomicCreateMetadata, "boolean");
    const recordGroup = (await NodeFSP.stat(f.record)).gid;
    const targetGroup = process.getgroups?.().find((group) => group !== recordGroup);
    if (NodeOS.platform() === "darwin" && targetGroup !== undefined)
      await NodeFSP.chown(NodePath.join(f.root, "sub"), process.getuid(), targetGroup);
    const missing = NodePath.join(f.root, "missing-parent");
    const unavailable = await run(helper, ["--protocol=1", "capabilities", missing]);
    NodeAssert.equal(unavailable.atomicCreateMetadata, false);
    let linked = null;
    if (NodeOS.platform() !== "win32") {
      await NodeFSP.symlink(f.root, NodePath.join(f.outside, "root-link"));
      linked = await run(helper, [
        "--protocol=1",
        "capabilities",
        NodePath.join(f.outside, "root-link"),
      ]);
      NodeAssert.equal(linked.atomicCreateMetadata, false);
    }
    NodeAssert.deepEqual(await NodeFSP.readdir(f.root), before);
    await NodeAssert.rejects(NodeFSP.stat(missing), { code: "ENOENT" });
    if (NodeOS.platform() !== "darwin") NodeAssert.equal(rooted.atomicCreateMetadata, false);
    evidence.push({
      case: "root-volume-capability-is-read-only-fails-closed-before-parent-admission",
      rooted,
      unavailable,
      linked,
    });
    const authority = rooted.strictCurrentRoot ? "strict-current-root" : "bound-object";
    const binding = await bind(helper, f, authority);
    const staged = NodePath.join(f.record, "stage");
    const target = NodePath.join(f.root, "sub", "created");
    const complete = "complete C\n".repeat(65536);
    await NodeFSP.writeFile(staged, complete, { mode: 0o666 });
    const sourceBefore = await NodeFSP.stat(staged, { bigint: true });
    const created = await run(helper, operation(binding, "create", "stage", "created", authority));
    if (!rooted.atomicCreateMetadata) {
      NodeAssert.equal(created.outcome, "unchanged");
      NodeAssert.notEqual(created.code, 0);
      await NodeAssert.rejects(NodeFSP.stat(target), { code: "ENOENT" });
      NodeAssert.equal(await NodeFSP.readFile(staged, "utf8"), complete);
      NodeAssert.deepEqual(created.flush, {
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
    NodeAssert.equal(created.outcome, "applied");
    NodeAssert.equal(created.code, 0, JSON.stringify(created));
    NodeAssert.equal(await NodeFSP.readFile(target, "utf8"), complete);
    NodeAssert.equal(await NodeFSP.readFile(staged, "utf8"), complete);
    NodeAssert.equal(created.sourceBefore.ino, String(sourceBefore.ino));
    NodeAssert.equal(created.sourceAfter.ino, created.sourceBefore.ino);
    NodeAssert.notEqual(created.destinationAfter.ino, created.sourceAfter.ino);
    const ordinary = NodePath.join(f.root, "sub", "ordinary");
    await NodeFSP.writeFile(ordinary, complete, { mode: 0o666 });
    const actual = await NodeFSP.stat(target),
      normal = await NodeFSP.stat(ordinary);
    NodeAssert.equal(actual.mode & 0o777, normal.mode & 0o777);
    NodeAssert.equal(actual.uid, normal.uid);
    NodeAssert.equal(actual.gid, normal.gid);
    for (const value of Object.values(created.flush))
      NodeAssert.equal(value, 0, JSON.stringify(created));
    await NodeFSP.writeFile(target, "public later edit");
    NodeAssert.equal(
      await NodeFSP.readFile(staged, "utf8"),
      complete,
      "The public inode must not be a hard link to the journal stage",
    );
    for (const kind of ["file", "symlink", "directory"]) {
      const name = `occupied-${kind}`,
        occupied = NodePath.join(f.root, "sub", name);
      if (kind === "file") await NodeFSP.writeFile(occupied, "outside B");
      else if (kind === "symlink") await NodeFSP.symlink(ordinary, occupied);
      else await NodeFSP.mkdir(occupied);
      const before = await NodeFSP.lstat(occupied);
      const refused = await run(helper, operation(binding, "create", "stage", name));
      NodeAssert.equal(refused.outcome, "unchanged");
      NodeAssert.notEqual(refused.code, 0);
      NodeAssert.equal((await NodeFSP.lstat(occupied)).ino, before.ino);
      if (kind === "file") NodeAssert.equal(await NodeFSP.readFile(occupied, "utf8"), "outside B");
      if (kind === "symlink") NodeAssert.equal(await NodeFSP.readlink(occupied), ordinary);
      if (kind === "directory") NodeAssert.deepEqual(await NodeFSP.readdir(occupied), []);
      NodeAssert.equal(await NodeFSP.readFile(staged, "utf8"), complete);
      NodeAssert.deepEqual(refused.flush, {
        sourceFile: -1,
        destinationFile: -1,
        sourceDirectory: -1,
        destinationDirectory: -1,
      });
      evidence.push({ case: `complete-create-occupied-${kind}-untouched`, refused });
    }
    await NodeFSP.symlink(staged, NodePath.join(f.record, "stage-link"));
    const badSource = await run(helper, operation(binding, "create", "stage-link", "bad-source"));
    NodeAssert.equal(badSource.outcome, "unchanged");
    NodeAssert.notEqual(badSource.code, 0);
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(f.root, "sub", "bad-source")), {
      code: "ENOENT",
    });
    evidence.push({
      case: "complete-create-distinct-inode-normal-mode-group-source-private-no-final-source-follow",
      sourceGroup: String(sourceBefore.gid),
      normalGroup: normal.gid,
      targetParentGroup: targetGroup ?? recordGroup,
      created,
      badSource,
    });
  });
  if (NodeOS.platform() === "darwin") {
    await fixture(async (f) => {
      const rooted = await run(helper, ["--protocol=1", "capabilities", f.root]);
      if (!rooted.atomicCreateMetadata) return;
      const parent = NodePath.join(f.root, "sub");
      NodeChildProcess.execFileSync("/bin/chmod", [
        "+a",
        "everyone deny read,file_inherit,only_inherit",
        parent,
      ]);
      const binding = await bind(helper, f);
      const complete = "ACL-complete C\n".repeat(4096);
      await NodeFSP.writeFile(NodePath.join(f.record, "stage"), complete, { mode: 0o666 });
      const ordinary = NodePath.join(parent, "ordinary");
      await NodeFSP.writeFile(ordinary, complete, { mode: 0o666 });
      const result = await run(helper, operation(binding, "create", "stage", "created"));
      NodeAssert.equal(result.outcome, "applied");
      NodeAssert.equal(result.code, 0, JSON.stringify(result));
      const target = NodePath.join(parent, "created"),
        actual = await NodeFSP.stat(target),
        normal = await NodeFSP.stat(ordinary);
      NodeAssert.equal(actual.size, Buffer.byteLength(complete));
      NodeAssert.equal(actual.mode & 0o777, normal.mode & 0o777);
      NodeAssert.equal(actual.uid, normal.uid);
      NodeAssert.equal(actual.gid, normal.gid);
      const acl = NodeChildProcess.execFileSync("/bin/ls", ["-le", target], { encoding: "utf8" });
      NodeAssert.ok(/everyone(?: inherited)? deny read/u.test(acl), acl);
      await NodeAssert.rejects(NodeFSP.readFile(target), { code: "EACCES" });
      await NodeAssert.rejects(NodeFSP.readFile(ordinary), { code: "EACCES" });
      NodeAssert.equal(
        result.flush.destinationFile,
        NodeOS.constants.errno.EACCES,
        "An applied clone with denied reopen needs durability attention, not fake success",
      );
      NodeAssert.equal(result.flush.sourceFile, 0);
      NodeAssert.equal(await NodeFSP.readFile(NodePath.join(f.record, "stage"), "utf8"), complete);
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
            const staged = NodePath.join(f.record, "stage");
            await NodeFSP.writeFile(staged, "complete relocation C", { mode: 0o666 });
            const child = launch(probe, operation(binding, "create", "stage", "created"), {
              [barrier === "BOUND"
                ? "SCIENT_PUBLICATION_BARRIER"
                : "SCIENT_PUBLICATION_CREATE_BARRIER"]: "1",
            });
            await child.next((line) => line === barrier);
            const moved = NodePath.join(f.outside, "moved");
            await NodeFSP.rename(
              relocation === "root" ? f.root : NodePath.join(f.root, "sub"),
              moved,
            );
            child.child.stdin.end("\n");
            const result = JSON.parse(await child.next((line) => line.includes('"outcome"')));
            NodeAssert.equal((await child.retired).code, 0);
            NodeAssert.notEqual(
              result.code,
              0,
              "Changed current-root binding cannot be acknowledged",
            );
            const outside = NodePath.join(
              moved,
              ...(relocation === "root" ? ["sub"] : []),
              "created",
            );
            if (barrier === "BOUND") {
              NodeAssert.equal(result.outcome, "unchanged");
              await NodeAssert.rejects(NodeFSP.stat(outside), { code: "ENOENT" });
              NodeAssert.deepEqual(result.flush, {
                sourceFile: -1,
                destinationFile: -1,
                sourceDirectory: -1,
                destinationDirectory: -1,
              });
            } else {
              NodeAssert.equal(result.outcome, "applied");
              NodeAssert.equal(await NodeFSP.readFile(outside, "utf8"), "complete relocation C");
              NodeAssert.notEqual(result.destinationAfter.ino, result.sourceAfter.ino);
              for (const value of Object.values(result.flush))
                NodeAssert.ok(value >= 0, JSON.stringify(result));
            }
            NodeAssert.equal(await NodeFSP.readFile(staged, "utf8"), "complete relocation C");
            evidence.push({
              case: `complete-create-${barrier.toLowerCase()}-${relocation}-relocation`,
              result,
            });
          });
  }
  if (unsupportedRoot)
    await fixture(async (f) => {
      const rooted = await run(helper, ["--protocol=1", "capabilities", f.root]);
      NodeAssert.equal(
        rooted.atomicCreateMetadata,
        false,
        "--unsupported-root must be an actual unsupported volume",
      );
      const binding = await bind(
        helper,
        f,
        rooted.strictCurrentRoot ? "strict-current-root" : "bound-object",
      );
      await NodeFSP.writeFile(NodePath.join(f.record, "stage"), "C", { mode: 0o666 });
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
      NodeAssert.equal(refused.outcome, "unchanged");
      NodeAssert.notEqual(refused.code, 0);
      NodeAssert.deepEqual(await NodeFSP.readdir(NodePath.join(f.root, "sub")), []);
      NodeAssert.equal(await NodeFSP.readFile(NodePath.join(f.record, "stage"), "utf8"), "C");
      evidence.push({
        case: "actual-unsupported-volume-create-refuses-without-source-parent-admission",
        rooted,
        refused,
      });
    }, unsupportedRoot);
}
async function qualifyChanged(capabilities) {
  await fixture(async (f) => {
    const before = await NodeFSP.readdir(f.outside);
    const binding = await bindParent(helper, f.outside);
    NodeAssert.equal(binding.parent.type, "directory");
    NodeAssert.deepEqual(await NodeFSP.readdir(f.outside), before);
    evidence.push({ case: "read-only-parent-binding-needs-no-private-directory", binding });
  });
  await fixture(async (f) => {
    const binding = await bindParent(helper, f.temporary);
    const privatePath = NodePath.join(f.temporary, "host-private");
    const result = await run(helper, directoryOperation(binding, "private-create", "host-private"));
    if (!capabilities.privateRetentionDirectory) {
      NodeAssert.equal(result.outcome, "unchanged");
      NodeAssert.notEqual(result.code, 0);
      await NodeAssert.rejects(NodeFSP.stat(privatePath), { code: "ENOENT" });
    } else {
      NodeAssert.equal(result.outcome, "applied");
      NodeAssert.equal(result.code, 0, JSON.stringify(result));
      NodeAssert.equal(result.destinationAfter.type, "directory");
      if (NodeOS.platform() !== "win32")
        NodeAssert.equal((await NodeFSP.stat(privatePath)).mode & 0o777, 0o700);
      const again = await run(
        helper,
        directoryOperation(binding, "private-create", "host-private"),
      );
      NodeAssert.equal(again.outcome, "unchanged");
      NodeAssert.equal(again.code, 0);
      NodeAssert.equal(again.destinationAfter.ino, result.destinationAfter.ino);
    }
    const broad = NodePath.join(f.temporary, "broad");
    await NodeFSP.mkdir(broad, { mode: 0o755 });
    if (NodeOS.platform() !== "win32") await NodeFSP.chmod(broad, 0o755);
    const modeBefore = (await NodeFSP.stat(broad)).mode;
    const refused = await run(helper, directoryOperation(binding, "private-create", "broad"));
    NodeAssert.equal(refused.outcome, "unchanged");
    NodeAssert.notEqual(refused.code, 0);
    NodeAssert.equal((await NodeFSP.stat(broad)).mode, modeBefore);
    if (NodeOS.platform() !== "win32") {
      await NodeFSP.symlink(f.outside, NodePath.join(f.temporary, "private-link"));
      const linked = await run(
        helper,
        directoryOperation(binding, "private-create", "private-link"),
      );
      NodeAssert.equal(linked.outcome, "unchanged");
      NodeAssert.notEqual(linked.code, 0);
      NodeAssert.deepEqual(await NodeFSP.readdir(f.outside), []);
      if (NodeOS.platform() === "darwin") {
        const aclDirectory = NodePath.join(f.temporary, "private-mode-broad-acl");
        await NodeFSP.mkdir(aclDirectory, { mode: 0o700 });
        NodeChildProcess.execFileSync("/bin/chmod", ["+a", "everyone allow read", aclDirectory]);
        const before = NodeChildProcess.execFileSync("/bin/ls", ["-led", aclDirectory], {
          encoding: "utf8",
        });
        const aclRefused = await run(
          helper,
          directoryOperation(binding, "private-create", "private-mode-broad-acl"),
        );
        NodeAssert.equal(aclRefused.outcome, "unchanged");
        NodeAssert.notEqual(aclRefused.code, 0);
        NodeAssert.equal(
          NodeChildProcess.execFileSync("/bin/ls", ["-led", aclDirectory], { encoding: "utf8" }),
          before,
        );
        evidence.push({ case: "private-existing-broad-acl-is-refused-without-repair", aclRefused });
        const deniedDirectory = NodePath.join(f.temporary, "private-child-deny");
        await NodeFSP.mkdir(deniedDirectory, { mode: 0o700 });
        NodeChildProcess.execFileSync("/bin/chmod", [
          "+a",
          "everyone deny read,file_inherit,only_inherit",
          deniedDirectory,
        ]);
        const denyBefore = NodeChildProcess.execFileSync("/bin/ls", ["-led", deniedDirectory], {
          encoding: "utf8",
        });
        const denyRefused = await run(
          helper,
          directoryOperation(binding, "private-create", "private-child-deny"),
        );
        NodeAssert.equal(denyRefused.outcome, "unchanged");
        NodeAssert.notEqual(denyRefused.code, 0);
        NodeAssert.equal(
          NodeChildProcess.execFileSync("/bin/ls", ["-led", deniedDirectory], { encoding: "utf8" }),
          denyBefore,
        );
        NodeAssert.deepEqual(await NodeFSP.readdir(deniedDirectory), []);
        evidence.push({
          case: "private-existing-child-deny-is-refused-before-journal-access-without-repair",
          denyRefused,
        });
        const inheritedParent = NodePath.join(f.temporary, "broad-inherited-parent");
        await NodeFSP.mkdir(inheritedParent);
        NodeChildProcess.execFileSync("/bin/chmod", [
          "+a",
          "everyone allow read,file_inherit,directory_inherit",
          inheritedParent,
        ]);
        const inheritedBinding = await bindParent(helper, inheritedParent);
        const born = await run(
          helper,
          directoryOperation(inheritedBinding, "private-create", "journal"),
        );
        NodeAssert.equal(born.outcome, "applied");
        NodeAssert.equal(born.code, 0, JSON.stringify(born));
        const privateChild = NodePath.join(inheritedParent, "journal");
        NodeAssert.equal((await NodeFSP.stat(privateChild)).mode & 0o777, 0o700);
        const privateAcl = NodeChildProcess.execFileSync("/bin/ls", ["-led", privateChild], {
          encoding: "utf8",
        });
        NodeAssert.ok(!privateAcl.includes("everyone allow"), privateAcl);
        await NodeFSP.writeFile(NodePath.join(privateChild, "owner-child"), "owner access");
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(privateChild, "owner-child"), "utf8"),
          "owner access",
        );
        NodeAssert.equal(
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
        const foreign = NodePath.join(f.temporary, "foreign-owner");
        await NodeFSP.mkdir(foreign, { mode: 0o700 });
        await NodeFSP.chown(foreign, 1, 1);
        const ownerRefused = await run(
          helper,
          directoryOperation(binding, "private-create", "foreign-owner"),
        );
        NodeAssert.equal(ownerRefused.outcome, "unchanged");
        NodeAssert.notEqual(ownerRefused.code, 0);
        NodeAssert.equal((await NodeFSP.stat(foreign)).uid, 1);
        evidence.push({ case: "private-wrong-owner-refused-without-repair", ownerRefused });
      }
    }
    if (NodeOS.platform() === "win32" && capabilities.privateRetentionDirectory) {
      const deniedDirectory = NodePath.join(f.temporary, "private-child-deny");
      const born = await run(
        helper,
        directoryOperation(binding, "private-create", "private-child-deny"),
      );
      NodeAssert.equal(born.code, 0);
      NodeChildProcess.execFileSync(
        "icacls.exe",
        [deniedDirectory, "/deny", "*S-1-1-0:(OI)(IO)(R)"],
        {
          stdio: "pipe",
        },
      );
      const before = NodeChildProcess.execFileSync("icacls.exe", [deniedDirectory], {
        encoding: "utf8",
      });
      const refused = await run(
        helper,
        directoryOperation(binding, "private-create", "private-child-deny"),
      );
      NodeAssert.equal(refused.outcome, "unchanged");
      NodeAssert.notEqual(refused.code, 0);
      NodeAssert.equal(
        NodeChildProcess.execFileSync("icacls.exe", [deniedDirectory], { encoding: "utf8" }),
        before,
      );
      NodeAssert.deepEqual(await NodeFSP.readdir(deniedDirectory), []);
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
      NodeAssert.equal(created.outcome, "unchanged");
      NodeAssert.notEqual(created.code, 0);
      await NodeAssert.rejects(NodeFSP.stat(NodePath.join(f.root, "sub", "chapter")), {
        code: "ENOENT",
      });
    } else {
      NodeAssert.equal(created.outcome, "applied");
      NodeAssert.equal(created.code, 0);
      const child = await bindParent(helper, f.root, "sub/chapter");
      const nested = await run(helper, directoryOperation(child, "mkdir", "sections"));
      NodeAssert.equal(nested.outcome, "applied");
      NodeAssert.equal(nested.code, 0);
      const occupied = await run(helper, directoryOperation(binding, "mkdir", "chapter"));
      NodeAssert.equal(occupied.outcome, "unchanged");
      NodeAssert.notEqual(occupied.code, 0);
      NodeAssert.equal(
        (await NodeFSP.readdir(NodePath.join(f.root, "sub", "chapter"))).join(","),
        "sections",
      );
    }
    evidence.push({ case: "authorized-missing-source-parent-mkdir-is-exclusive", created });
  });
  await fixture(async (f) => {
    const binding = await bind(
      helper,
      f,
      capabilities.strictCurrentRoot ? "strict-current-root" : "bound-object",
    );
    const target = NodePath.join(f.root, "sub", "source"),
      staged = NodePath.join(f.record, "stage");
    await NodeFSP.writeFile(target, "preflight A", { mode: 0o644 });
    await NodeFSP.writeFile(staged, "local C", { mode: 0o600 });
    if (capabilities.atomicExchange) {
      const copied = await run(helper, operation(binding, "metadata", "source", "stage"));
      NodeAssert.equal(copied.code, 0);
      NodeAssert.equal(copied.outcome, "applied");
      await NodeFSP.rename(target, NodePath.join(f.root, "sub", "preflight"));
      await NodeFSP.writeFile(target, "late outside B", { mode: 0o600 });
      if (NodeOS.platform() === "darwin") {
        NodeChildProcess.execFileSync("/usr/bin/xattr", [
          "-w",
          "com.scient.publication",
          "actual-displaced-B",
          target,
        ]);
        NodeChildProcess.execFileSync("/bin/chmod", ["+a", "everyone deny write", target]);
      }
      const published = await run(helper, operation(binding, "exchange", "stage", "source"));
      NodeAssert.equal(published.code, 0, JSON.stringify(published));
      NodeAssert.equal(published.outcome, "applied");
      NodeAssert.equal(await NodeFSP.readFile(target, "utf8"), "local C");
      NodeAssert.equal(await NodeFSP.readFile(staged, "utf8"), "late outside B");
      NodeAssert.equal((await NodeFSP.stat(target)).mode & 0o777, 0o600);
      if (NodeOS.platform() === "darwin") {
        NodeAssert.equal(
          NodeChildProcess.execFileSync(
            "/usr/bin/xattr",
            ["-p", "com.scient.publication", target],
            {
              encoding: "utf8",
            },
          ).trim(),
          "actual-displaced-B",
        );
        const acl = NodeChildProcess.execFileSync("/bin/ls", ["-le", target], { encoding: "utf8" });
        NodeAssert.ok(acl.includes("everyone deny write"), acl);
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
      NodeAssert.equal(refused.outcome, "unchanged");
      NodeAssert.notEqual(refused.code, 0);
      NodeAssert.equal(await NodeFSP.readFile(target, "utf8"), "preflight A");
      NodeAssert.equal(await NodeFSP.readFile(staged, "utf8"), "local C");
      NodeAssert.equal((await NodeFSP.stat(target)).mode & 0o777, 0o644);
      NodeAssert.equal((await NodeFSP.stat(staged)).mode & 0o777, 0o600);
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
      NodeAssert.equal(refused.lease, "refused");
      NodeAssert.notEqual(refused.code, 0);
      NodeAssert.equal((await lease.retired).code, 0);
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
      NodeAssert.equal(blocked.lease, "refused");
      NodeAssert.notEqual(blocked.code, 0);
      NodeAssert.equal((await contender.retired).code, 0);
      evidence.push({
        case: "duplicate-parent-ex-dominates-sh-under-real-lock-contention",
        blocked,
      });
    }
    await NodeFSP.writeFile(NodePath.join(f.record, "stage"), "owned C");
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
    NodeAssert.equal(result.code, 0);
    NodeAssert.equal(result.outcome, "applied");
    await retireLease(exclusive);
    const sharedOnly = launch(helper, leaseArguments([{ ...binding, mode: "shared" }]));
    await sharedOnly.next((line) => line.includes('"lease":"acquired"'));
    sharedOnly.child.stdin.write(frame(directoryOperation(binding, "mkdir", "forbidden")));
    const refused = JSON.parse(await sharedOnly.next((line) => line.includes('"lease":"refused"')));
    NodeAssert.notEqual(refused.code, 0);
    NodeAssert.equal((await sharedOnly.retired).code, 0);
    await NodeAssert.rejects(NodeFSP.stat(NodePath.join(f.root, "sub", "forbidden")), {
      code: "ENOENT",
    });
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
      const volume = await bindParent(probe, NodePath.parse(f.root).root);
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
      NodeAssert.equal(blocked.lease, "refused");
      NodeAssert.notEqual(blocked.code, 0);
      NodeAssert.equal((await contender.retired).code, 0);
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
      if (NodeOS.platform() === "win32")
        await NodeAssert.rejects(
          NodeFSP.rename(NodePath.join(f.root, "sub"), NodePath.join(f.outside, "moved")),
        );
      else await NodeFSP.rename(NodePath.join(f.root, "sub"), NodePath.join(f.outside, "moved"));
      child.child.stdin.end("\n");
      const result = JSON.parse(await child.next((line) => line.includes('"outcome"')));
      NodeAssert.equal((await child.retired).code, 0);
      if (NodeOS.platform() === "win32") NodeAssert.equal(result.outcome, "applied");
      else {
        NodeAssert.equal(result.outcome, "unchanged");
        NodeAssert.notEqual(result.code, 0);
        await NodeAssert.rejects(NodeFSP.stat(NodePath.join(f.outside, "moved", "chapter")), {
          code: "ENOENT",
        });
      }
      evidence.push({
        case: "source-parent-mkdir-relocation-cannot-create-outside-authority",
        result,
      });
    });
  if (probe && capabilities.atomicPublicationMetadata && NodeOS.platform() === "darwin")
    for (const relocation of ["parent", "root"])
      await fixture(async (f) => {
        const binding = await bind(probe, f);
        const target = NodePath.join(f.root, "sub", "source");
        await NodeFSP.writeFile(target, "actual displaced B", { mode: 0o600 });
        await NodeFSP.writeFile(NodePath.join(f.record, "stage"), "local C", { mode: 0o644 });
        const child = launch(probe, operation(binding, "exchange", "stage", "source"), {
          SCIENT_PUBLICATION_METADATA_BARRIER: "1",
        });
        await child.next((line) => line === "EXCHANGED");
        const moved = NodePath.join(f.outside, "moved");
        await NodeFSP.rename(relocation === "parent" ? NodePath.dirname(target) : f.root, moved);
        const outsideTarget = NodePath.join(
          moved,
          ...(relocation === "root" ? ["sub"] : []),
          "source",
        );
        const mode = (await NodeFSP.stat(outsideTarget)).mode & 0o777;
        child.child.stdin.end("\n");
        const result = JSON.parse(await child.next((line) => line.includes('"outcome"')));
        NodeAssert.equal((await child.retired).code, 0);
        NodeAssert.equal(result.outcome, "applied");
        NodeAssert.notEqual(result.code, 0);
        NodeAssert.equal((await NodeFSP.stat(outsideTarget)).mode & 0o777, mode);
        NodeAssert.equal(await NodeFSP.readFile(outsideTarget, "utf8"), "local C");
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(f.record, "stage"), "utf8"),
          "actual displaced B",
        );
        evidence.push({
          case: `post-exchange-${relocation}-relocation-denies-metadata-write`,
          result,
        });
      });
}
try {
  const capabilities = await run(helper, ["--protocol=1", "capabilities"]);
  evidence.push({ case: "capabilities", ...capabilities });
  NodeAssert.equal(capabilities.publicationLease, true);
  if (selection !== "previous") await qualifyChanged(capabilities);
  if (selection !== "previous") await qualifyCreation();
  if (selection !== "changed") {
    if (!capabilities.strictCurrentRoot) {
      await fixture(async (f) => {
        await NodeFSP.writeFile(NodePath.join(f.root, "sub", "source"), "A");
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
        NodeAssert.equal(refused.outcome, "unchanged");
        NodeAssert.notEqual(refused.code, 0);
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(f.root, "sub", "source"), "utf8"),
          "A",
        );
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
      const target = NodePath.join(f.root, "sub", "manuscript");
      await NodeFSP.writeFile(target, "late outside B", { mode: 0o600 });
      await NodeFSP.writeFile(NodePath.join(f.record, "stage"), "local C", { mode: 0o600 });
      const writer = await NodeFSP.open(target, "r+");
      try {
        const result = await run(helper, operation(binding, "exchange", "stage", "manuscript"));
        if (!capabilities.atomicExchange) {
          NodeAssert.equal(result.outcome, "unchanged");
          NodeAssert.notEqual(result.code, 0);
          NodeAssert.equal(await NodeFSP.readFile(target, "utf8"), "late outside B");
          NodeAssert.equal(
            await NodeFSP.readFile(NodePath.join(f.record, "stage"), "utf8"),
            "local C",
          );
          evidence.push({
            case: "atomic-replacement-unavailable-refuses-before-displacement",
            result,
          });
        } else {
          NodeAssert.equal(result.outcome, "applied");
          NodeAssert.equal(result.code, 0);
          NodeAssert.equal(await NodeFSP.readFile(target, "utf8"), "local C");
          NodeAssert.equal(
            await NodeFSP.readFile(NodePath.join(f.record, "stage"), "utf8"),
            "late outside B",
          );
          await writer.write("held-writer D", 0, "utf8");
          NodeAssert.ok(
            (await NodeFSP.readFile(NodePath.join(f.record, "stage"), "utf8")).startsWith(
              "held-writer D",
            ),
          );
          NodeAssert.equal(await NodeFSP.readFile(target, "utf8"), "local C");
          if (NodeOS.platform() !== "win32")
            NodeAssert.equal((await NodeFSP.stat(target)).mode & 0o777, 0o600);
          evidence.push({ case: "exchange-retains-actual-entry-and-held-writer", result });
        }
      } finally {
        await writer.close();
      }
    });
    await fixture(async (f) => {
      const binding = await bind(helper, f);
      const source = NodePath.join(f.root, "sub", "source");
      await NodeFSP.writeFile(source, "outside B");
      await NodeFSP.writeFile(NodePath.join(f.record, "occupied"), "retained A");
      const refused = await run(helper, operation(binding, "capture", "source", "occupied"));
      NodeAssert.equal(refused.outcome, "unchanged");
      NodeAssert.notEqual(refused.code, 0);
      NodeAssert.equal(await NodeFSP.readFile(source, "utf8"), "outside B");
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(f.record, "occupied"), "utf8"),
        "retained A",
      );
      const captured = await run(helper, operation(binding, "capture", "source", "captured"));
      NodeAssert.equal(captured.outcome, "applied");
      NodeAssert.equal(captured.code, 0);
      await NodeFSP.writeFile(source, "newer C");
      const restore = await run(helper, operation(binding, "restore", "captured", "source"));
      NodeAssert.equal(restore.outcome, "unchanged");
      NodeAssert.notEqual(restore.code, 0);
      NodeAssert.equal(await NodeFSP.readFile(source, "utf8"), "newer C");
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(f.record, "captured"), "utf8"),
        "outside B",
      );
      const linked = await run(helper, operation(binding, "link", "captured", "destination"));
      NodeAssert.equal(linked.outcome, "applied");
      NodeAssert.equal(linked.code, 0);
      NodeAssert.equal(linked.sourceAfter.ino, linked.destinationAfter.ino);
      await NodeFSP.writeFile(NodePath.join(f.root, "sub", "destination"), "descriptor edit E");
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(f.record, "captured"), "utf8"),
        "descriptor edit E",
      );
      const blockedLink = await run(helper, operation(binding, "link", "occupied", "destination"));
      NodeAssert.equal(blockedLink.outcome, "unchanged");
      NodeAssert.notEqual(blockedLink.code, 0);
      const installed = await run(helper, operation(binding, "move", "occupied", "installed"));
      NodeAssert.equal(installed.outcome, "applied");
      NodeAssert.equal(installed.code, 0);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(f.root, "sub", "installed"), "utf8"),
        "retained A",
      );
      const restored = await run(helper, operation(binding, "restore", "captured", "restored"));
      NodeAssert.equal(restored.outcome, "applied");
      NodeAssert.equal(restored.code, 0);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(f.root, "sub", "restored"), "utf8"),
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
    if (NodeOS.platform() !== "win32")
      await fixture(async (f) => {
        const binding = await bind(helper, f);
        const referent = NodePath.join(f.outside, "referent");
        await NodeFSP.writeFile(referent, "outside must survive");
        await NodeFSP.symlink(referent, NodePath.join(f.root, "sub", "late:link"));
        const captured = await run(
          helper,
          operation(binding, "capture", "late:link", "retained:link"),
        );
        NodeAssert.equal(captured.outcome, "applied");
        NodeAssert.equal(captured.code, 0);
        NodeAssert.equal(captured.destinationAfter.type, "symlink");
        NodeAssert.equal(
          await NodeFSP.readlink(NodePath.join(f.record, "retained:link")),
          referent,
        );
        NodeAssert.equal(await NodeFSP.readFile(referent, "utf8"), "outside must survive");
        evidence.push({ case: "captures-late-final-symlink-without-following-referent", captured });
      });
    await fixture(async (f) => {
      const binding = await bind(helper, f);
      await NodeFSP.writeFile(NodePath.join(f.root, "sub", "source"), "A");
      await NodeFSP.rename(NodePath.join(f.root, "sub"), NodePath.join(f.outside, "old-parent"));
      await NodeFSP.mkdir(NodePath.join(f.root, "sub"));
      await NodeFSP.writeFile(NodePath.join(f.root, "sub", "source"), "replacement B");
      const refused = await run(helper, operation(binding, "capture", "source", "captured"));
      NodeAssert.equal(refused.outcome, "unchanged");
      NodeAssert.notEqual(refused.code, 0);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(f.root, "sub", "source"), "utf8"),
        "replacement B",
      );
      evidence.push({ case: "stale-parent-identity-refuses-before-capture", refused });
    });
    if (probe) {
      for (const kind of capabilities.atomicExchange
        ? ["capture", "exchange", "move", "link"]
        : ["capture", "move", "link"])
        await fixture(async (f) => {
          const binding = await bind(probe, f);
          await NodeFSP.writeFile(NodePath.join(f.root, "sub", "source"), "outside B");
          await NodeFSP.writeFile(NodePath.join(f.record, "stage"), "local C");
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
          if (NodeOS.platform() === "win32") {
            await NodeAssert.rejects(
              NodeFSP.rename(NodePath.join(f.root, "sub"), NodePath.join(f.outside, "sub")),
            );
          } else
            await NodeFSP.rename(NodePath.join(f.root, "sub"), NodePath.join(f.outside, "sub"));
          process_.child.stdin.end("\n");
          const result = JSON.parse(await process_.next((line) => line.startsWith("{")));
          NodeAssert.equal((await process_.retired).code, 0);
          if (NodeOS.platform() !== "win32") {
            NodeAssert.equal(result.outcome, "unchanged");
            NodeAssert.notEqual(result.code, 0);
            NodeAssert.equal(
              await NodeFSP.readFile(NodePath.join(f.outside, "sub", "source"), "utf8"),
              "outside B",
            );
            NodeAssert.equal(
              await NodeFSP.readFile(NodePath.join(f.record, "stage"), "utf8"),
              "local C",
            );
          } else {
            NodeAssert.equal(result.outcome, "applied");
            NodeAssert.equal(result.code, 0);
          }
          evidence.push({ case: `held-descendant-relocation-${kind}`, result });
        });
      for (const relocation of ["root", "ancestor", "root-replacement"])
        await fixture(async (f) => {
          const binding = await bind(probe, f);
          await NodeFSP.writeFile(NodePath.join(f.root, "sub", "source"), "authorized A");
          const process_ = launch(probe, operation(binding, "capture", "source", "captured"), {
            SCIENT_PUBLICATION_BARRIER: "1",
          });
          await process_.next((line) => line === "BOUND");
          const source = relocation === "ancestor" ? NodePath.dirname(f.root) : f.root;
          const moved = NodePath.join(f.outside, "moved");
          if (NodeOS.platform() === "win32")
            await NodeAssert.rejects(NodeFSP.rename(source, moved));
          else {
            await NodeFSP.rename(source, moved);
            if (relocation === "root-replacement") {
              await NodeFSP.mkdir(NodePath.join(f.root, "sub"), { recursive: true });
              await NodeFSP.writeFile(NodePath.join(f.root, "sub", "source"), "foreign B");
            }
          }
          process_.child.stdin.end("\n");
          const result = JSON.parse(await process_.next((line) => line.startsWith("{")));
          NodeAssert.equal((await process_.retired).code, 0);
          if (NodeOS.platform() === "darwin") {
            NodeAssert.equal(result.outcome, "unchanged");
            NodeAssert.notEqual(result.code, 0);
          } else if (NodeOS.platform() === "linux") {
            // Landlock binds authority to the original root object, but changed path binding cannot acknowledge.
            NodeAssert.equal(result.outcome, "applied");
            NodeAssert.notEqual(result.code, 0);
            NodeAssert.equal(
              await NodeFSP.readFile(NodePath.join(f.record, "captured"), "utf8"),
              "authorized A",
            );
            if (relocation === "root-replacement")
              NodeAssert.equal(
                await NodeFSP.readFile(NodePath.join(f.root, "sub", "source"), "utf8"),
                "foreign B",
              );
          } else {
            NodeAssert.equal(result.outcome, "applied");
            NodeAssert.equal(result.code, 0);
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
              NodePath.join(f.root, "sub"),
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
          NodeAssert.equal((await first.retired).code, 0);
          await second.next((line) => line.includes('"lease":"acquired"'));
          second.child.stdin.end(Buffer.alloc(4));
          NodeAssert.equal((await second.retired).code, 0);
          evidence.push({ case: "cross-process-nested-root-identity-lease-serialization" });
        });
      if (NodeOS.platform() !== "win32")
        await fixture(async (f) => {
          const binding = await bind(probe, f);
          await NodeFSP.writeFile(NodePath.join(f.record, "stage"), "owned C");
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
          NodeAssert.equal(
            await NodeFSP.readFile(NodePath.join(f.root, "sub", "published"), "utf8"),
            "owned C",
          );
          successor.child.stdin.end(Buffer.alloc(4));
          NodeAssert.equal((await successor.retired).code, 0);
          evidence.push({ case: "holder-sigkill-does-not-retire-inherited-native-writer-lock" });
        });
    }
  }
  console.log(
    JSON.stringify(
      {
        platform: NodeOS.platform(),
        arch: process.arch,
        observations: evidence,
        gaps: [
          ...(probe ? [] : ["Relocation and retirement probes require --probe-helper."]),
          ...(NodeOS.platform() === "win32"
            ? [
                "Atomic replace-and-retain is unqualified and refused; Windows normal-save cutover remains blocked.",
                "Reparse/junction, DACL/ADS and directory-flush qualification remains required.",
              ]
            : []),
          ...(NodeOS.platform() === "linux"
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

// The signed dev bundle enters through Electron's native CFBundleExecutable.
// Keep this synchronous: the desktop main bundle installs open-file listeners
// before the first Electron event-loop turn.
const fs = require("node:fs");
const path = require("node:path");

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "scient-dev-bootstrap.json"), "utf8"),
);
const managed = process.env.SCIENT_NEXT_DEV_RUNNER_ACTIVE === "1";
const environmentPath = managed
  ? process.env.SCIENT_DEV_APP_ENV_FILE
  : config.fallbackEnvironmentPath;

if (managed && !environmentPath)
  throw new Error("Managed dev app is missing its environment file.");
if (environmentPath) {
  const fd = fs.openSync(environmentPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("Development environment file is not private and bounded.");
    }
    const values = JSON.parse(fs.readFileSync(fd, "utf8"));
    for (const [name, value] of Object.entries(values)) {
      if (
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        typeof value === "string" &&
        !value.includes("\0") &&
        (managed || !process.env[name])
      )
        process.env[name] = value;
    }
  } finally {
    fs.closeSync(fd);
    if (managed) fs.rmSync(environmentPath, { force: true });
  }
}

process.env.SCIENT_DEV_BOOTSTRAP = "1";
process.env.SCIENT_DEV_BOOTSTRAP_ROOT = config.repoRoot;
process.env.SCIENT_DEV_BOOTSTRAP_STATE_ROOT = config.stateRoot;
process.env.SCIENT_DEV_BOOTSTRAP_ROLE = config.role;
process.env.SCIENT_DEV_BOOTSTRAP_NODE = config.nodePath;
process.env.SCIENT_DEV_APP_ROLE = config.role;
process.env.SCIENT_NEXT_HOME = config.stateRoot;
process.env.SCIENT_NEXT_SAFETY_ENVELOPE = "true";
if (managed) delete process.env.SCIENT_DEV_COLD_BOOTSTRAP;
else process.env.SCIENT_DEV_COLD_BOOTSTRAP = "1";

if (managed && process.env.SCIENT_DEV_APP_PID_FILE) {
  const pidPath = process.env.SCIENT_DEV_APP_PID_FILE;
  const tmpPath = `${pidPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmpPath, pidPath);
}

require(config.mainEntryPath);

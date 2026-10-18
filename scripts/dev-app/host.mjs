// Operating-system work for the standing dev app's controller: process
// identity, and on Windows the job host, its scheduled task and the Start-menu
// shortcut. macOS keeps launchd ownership through scripts/local-dev-app.mjs.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone controller CLI has no Effect runtime.
export const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone controller CLI has no Effect runtime.
export const hostArch = NodeOS.arch();

const POWERSHELL = "powershell.exe";
const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

export function runPowerShell(
  script,
  { timeout = 60_000, spawnSync = NodeChildProcess.spawnSync } = {},
) {
  const result = spawnSync(POWERSHELL, [...POWERSHELL_ARGS, "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// ── process identity ──────────────────────────────────────────────────────

/** Start-time identity for lock owners (compared, never used to kill). */
const WINDOWS_START_EXPRESSION = "$p.StartTime.ToUniversalTime().ToString('o')";

/** {state:"alive", start} | {state:"gone"} | {state:"unknown"}. */
export function processStart(pid, { spawnSync = NodeChildProcess.spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { state: "gone" };
  if (hostPlatform === "win32") {
    const result = runPowerShell(
      `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue; if ($p) { ${WINDOWS_START_EXPRESSION} } else { 'gone' }`,
      { timeout: 20_000, spawnSync },
    );
    if (!result.ok || !result.stdout) return { state: "unknown" };
    return result.stdout === "gone" ? { state: "gone" } : { state: "alive", start: result.stdout };
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  if (result.error) return { state: "unknown" };
  const start = result.stdout?.trim();
  if (result.status !== 0 || !start) return { state: "gone" };
  return { state: "alive", start };
}

/** For lock records: a recorded owner is gone when its pid no longer has its start time. */
export function ownerState(owner, dependencies) {
  const current = processStart(owner?.pid, dependencies);
  if (current.state === "unknown") return "unknown";
  if (current.state === "gone") return "gone";
  return current.start === owner.start ? "alive" : "gone";
}

export function selfOwner(purpose) {
  const self = processStart(process.pid);
  if (self.state !== "alive") throw new Error("Could not read this process's start time.");
  return { pid: process.pid, start: self.start, purpose, at: new Date().toISOString() };
}

const SHELLS = new Set([
  "bash.exe",
  "sh.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "zsh",
  "bash",
  "sh",
]);

/** Pids of this process and its callers (shells, `timeout`, the terminal). */
function selfAndAncestors(entries) {
  const parents = new Map(entries.map((entry) => [entry.pid, entry.parent]));
  const chain = new Set();
  for (let pid = process.pid; pid > 0 && !chain.has(pid); pid = parents.get(pid) ?? 0) {
    chain.add(pid);
  }
  return chain;
}

/**
 * Processes whose executable or command line lies under one of `roots`,
 * except this process, its callers and shells (whose command line may merely
 * mention a path). `null` when the process list cannot be read.
 */
export function findProcessesUnder(roots, { spawnSync = NodeChildProcess.spawnSync } = {}) {
  const needles = roots.map((root) => NodePath.resolve(root).toLowerCase());
  let entries;
  if (hostPlatform === "win32") {
    const result = runPowerShell(
      'Get-CimInstance Win32_Process | ForEach-Object { "{0}`t{1}`t{2}`t{3}" -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath, $_.CommandLine }',
      { timeout: 60_000, spawnSync },
    );
    if (!result.ok) return null;
    entries = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.split("\t"))
      .filter((fields) => fields.length >= 2)
      .map(([pid, parent, executable = "", commandLine = ""]) => ({
        pid: Number(pid),
        parent: Number(parent),
        name: NodePath.win32.basename(executable).toLowerCase(),
        executable,
        commandLine,
      }));
  } else {
    const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    if (result.status !== 0) return null;
    entries = result.stdout
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
      .filter((match) => match !== null)
      .map((match) => ({
        pid: Number(match[1]),
        parent: Number(match[2]),
        name: NodePath.basename(match[3].split(" ")[0]).replace(/^-/u, ""),
        executable: "",
        commandLine: match[3],
      }));
  }
  const callers = selfAndAncestors(entries);
  return entries
    .filter((entry) => !callers.has(entry.pid) && !SHELLS.has(entry.name))
    .filter((entry) =>
      needles.some((needle) =>
        `${entry.executable}\n${entry.commandLine}`.toLowerCase().includes(needle),
      ),
    )
    .map(({ pid, executable, commandLine }) => ({ pid, executable, commandLine }));
}

// ── Windows: job host and job control ─────────────────────────────────────

export function launchJobName(token) {
  return `Local\\ScientDevLaunch-${launchTokenHash(token)}`;
}

export function launchTokenHash(token) {
  return NodeCrypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
}

/**
 * Written into the controller directory at install. `host <launch.json>` runs
 * the runner inside a kill-on-close job that its descendants cannot leave;
 * `terminate <jobName>` empties an existing job and reports "empty",
 * "not-found" or "busy:<n>".
 */
export const WINDOWS_JOB_SCRIPT = String.raw`param([string]$Mode, [string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ScientDevJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A, B; public uint LimitFlags; public UIntPtr C, D; public uint E; public UIntPtr F; public uint G, H; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr A, B, C, D; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long A, B, C, D; public uint Faults, Total, Active, Terminated; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int cb; public string A, B, C; public int D, E, F, G, H, I, J, Flags; public short Show, K; public IntPtr L, Input, Output, Error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int Pid, Tid; }
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, int length);
  [DllImport("kernel32", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
  [DllImport("kernel32", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
  [DllImport("kernel32", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32", SetLastError = true)] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  const uint KillOnJobClose = 0x2000, CreateSuspended = 0x4, QueryAndTerminate = 0x0004 | 0x0008;
  const uint ProcessTerminate = 0x0001, QueryLimited = 0x1000, Synchronize = 0x00100000;

  public static long SelfCreation() {
    long creation, exit, kernel, user;
    if (!GetProcessTimes(GetCurrentProcess(), out creation, out exit, out kernel, out user)) throw new Win32Exception();
    return creation;
  }

  // Validates and terminates through one handle, so a reused PID is never hit.
  public static string KillIfCreated(int pid, long expectedCreation) {
    IntPtr process = OpenProcess(ProcessTerminate | QueryLimited | Synchronize, false, pid);
    if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "gone" : "unknown";
    try {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return "unknown";
      // CIM reports creation to the microsecond; a reused PID cannot start within 1 us.
      if (Math.Abs(creation - expectedCreation) >= 10) return "other";
      if (!TerminateProcess(process, 1)) return "unknown";
      WaitForSingleObject(process, 10000);
      return "killed";
    } finally { CloseHandle(process); }
  }

  public static IntPtr Create(string name) {
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Win32Exception();
    if (Marshal.GetLastWin32Error() == 183) { CloseHandle(job); throw new Exception("The launch job already exists."); }
    Extended limits = new Extended();
    limits.Basic.LimitFlags = KillOnJobClose;
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();
    return job;
  }

  public static int Start(IntPtr job, string commandLine, string directory, out IntPtr process) {
    StartupInfo startup = new StartupInfo(); startup.cb = Marshal.SizeOf(startup);
    ProcessInfo info;
    if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, CreateSuspended, IntPtr.Zero, directory, ref startup, out info)) throw new Win32Exception();
    if (!AssignProcessToJobObject(job, info.Process)) {
      int error = Marshal.GetLastWin32Error();
      TerminateProcess(info.Process, 1); CloseHandle(info.Thread); CloseHandle(info.Process);
      throw new Win32Exception(error);
    }
    if (ResumeThread(info.Thread) == 0xFFFFFFFF) throw new Win32Exception();
    CloseHandle(info.Thread);
    process = info.Process;
    return info.Pid;
  }

  public static uint Wait(IntPtr process) {
    WaitForSingleObject(process, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(process, out code); return code;
  }

  public static long Active(IntPtr job) {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return -1;
    return info.Active;
  }

  public static bool Empty(IntPtr job, int timeoutMs) {
    TerminateJobObject(job, 1);
    for (int waited = 0; waited <= timeoutMs; waited += 100) {
      if (Active(job) == 0) return true;
      System.Threading.Thread.Sleep(100);
    }
    return false;
  }

  public static string TerminateByName(string name, int timeoutMs) {
    IntPtr job = OpenJobObject(QueryAndTerminate, false, name);
    if (job == IntPtr.Zero) return Marshal.GetLastWin32Error() == 2 ? "not-found" : "unknown";
    try { return Empty(job, timeoutMs) ? "empty" : "busy:" + Active(job); }
    finally { CloseHandle(job); }
  }
}
'@
function Write-JsonAtomic([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  Move-Item -Force -LiteralPath $temporary -Destination $Path
}
if ($Mode -eq 'terminate') {
  [ScientDevJob]::TerminateByName($Target, 10000)
  exit 0
}
if ($Mode -eq 'kill') {
  $parts = $Target.Split(':')
  [ScientDevJob]::KillIfCreated([int]$parts[0], [long]$parts[1])
  exit 0
}
if ($Mode -ne 'host') { throw "Unknown mode $Mode" }
$launch = Get-Content -Raw -Encoding UTF8 -LiteralPath $Target | ConvertFrom-Json
$job = [ScientDevJob]::Create($launch.jobName)
$process = [IntPtr]::Zero
$runnerPid = [ScientDevJob]::Start($job, $launch.runnerCommandLine, $launch.checkout, [ref]$process)
Write-JsonAtomic $launch.jobPath @{ tokenHash = $launch.tokenHash; jobName = $launch.jobName; hostPid = $PID; hostCreation = [string][ScientDevJob]::SelfCreation(); runnerPid = $runnerPid }
$code = [ScientDevJob]::Wait($process)
if ([ScientDevJob]::Empty($job, 10000)) {
  Write-JsonAtomic $launch.jobEmptyPath @{ tokenHash = $launch.tokenHash; runnerExitCode = $code; at = (Get-Date).ToUniversalTime().ToString('o') }
}
`;

/** Empties the named launch job; "empty" | "not-found" | "busy:<n>" | "unknown". */
export function terminateWindowsJob(jobScriptPath, jobName) {
  const result = NodeChildProcess.spawnSync(
    POWERSHELL,
    [...POWERSHELL_ARGS, "-File", jobScriptPath, "terminate", jobName],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  const verdict = result.status === 0 ? result.stdout.trim().split(/\r?\n/u).at(-1) : "";
  return verdict === "empty" || verdict === "not-found" || verdict?.startsWith("busy:")
    ? verdict
    : "unknown";
}

/** Kills `pid` only if it still has `creation` (FILETIME); "killed" | "gone" | "other" | "unknown". */
export function terminateWindowsProcess(jobScriptPath, pid, creation) {
  const result = NodeChildProcess.spawnSync(
    POWERSHELL,
    [...POWERSHELL_ARGS, "-File", jobScriptPath, "kill", `${String(pid)}:${String(creation)}`],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  const verdict = result.status === 0 ? result.stdout.trim().split(/\r?\n/u).at(-1) : "";
  return ["killed", "gone", "other"].includes(verdict) ? verdict : "unknown";
}

/** Whether the scheduled task (and so a job host) is still running. Null when unknown. */
export function scheduledTaskRunning(taskName) {
  const result = runPowerShell(
    `(Get-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction Stop).State.ToString()`,
  );
  return result.ok ? result.stdout === "Running" : null;
}

// ── Windows: scheduled task and Start-menu shortcut ───────────────────────

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * On demand only (no triggers), in the user's interactive session at least
 * privilege, no run-time limit, and never a second copy.
 */
export function scheduledTaskXml({ userId, command, args, workingDirectory, description }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlEscape(description)}</Description></RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function schtasks(args) {
  const result = NodeChildProcess.spawnSync("schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function registerScheduledTask(taskName, xml, scratchDir) {
  const xmlPath = NodePath.join(scratchDir, "scheduled-task.xml");
  NodeFS.writeFileSync(
    xmlPath,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]),
  );
  try {
    const result = schtasks(["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
    if (!result.ok) throw new Error(`Could not register the scheduled task: ${result.output}`);
  } finally {
    NodeFS.rmSync(xmlPath, { force: true });
  }
}

export function runScheduledTask(taskName) {
  const result = schtasks(["/Run", "/TN", taskName]);
  if (!result.ok) throw new Error(`Could not start the scheduled task: ${result.output}`);
}

export function deleteScheduledTask(taskName) {
  schtasks(["/Delete", "/TN", taskName, "/F"]);
}

/** A double-quoted Windows command-line argument (CommandLineToArgvW rules). */
export function quoteWindowsArgument(value) {
  const text = String(value);
  if (text.length > 0 && !/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

export function startMenuShortcutPath(name) {
  return NodePath.join(
    process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${name}.lnk`,
  );
}

export function writeStartMenuShortcut({ path, target, args, workingDirectory, icon }) {
  const result = runPowerShell(
    [
      "$shell = New-Object -ComObject WScript.Shell",
      `$link = $shell.CreateShortcut(${psQuote(path)})`,
      `$link.TargetPath = ${psQuote(target)}`,
      `$link.Arguments = ${psQuote(args)}`,
      `$link.WorkingDirectory = ${psQuote(workingDirectory)}`,
      "$link.WindowStyle = 7",
      ...(icon ? [`$link.IconLocation = ${psQuote(`${icon},0`)}`] : []),
      "$link.Save()",
    ].join("; "),
  );
  if (!result.ok) throw new Error(`Could not create the Start-menu shortcut: ${result.stderr}`);
}

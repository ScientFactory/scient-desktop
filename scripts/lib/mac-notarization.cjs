// FILE: mac-notarization.cjs
// Purpose: Runs a bounded, observable Apple notarization workflow for signed macOS releases.
// Layer: Release/build helper

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  SCIENT_APPSNAP_HELPER_BUNDLE_PATH,
  SCIENT_APPSNAP_HELPER_IDENTIFIER,
  SCIENT_ELECTRON_HELPERS,
  SCIENT_MAC_BUNDLE_IDENTIFIER,
} = require("./mac-signing-policy.cjs");

const COMMAND_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUTS = Object.freeze({
  commandMs: 2 * 60 * 1000,
  historyRecoveryDelayMs: 5 * 1000,
  logAttempts: 3,
  pollErrorLimit: 3,
  pollIntervalMs: 30 * 1000,
  processingMs: 90 * 60 * 1000,
  submitMs: 15 * 60 * 1000,
});

class MacNotarizationCommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MacNotarizationCommandError";
    this.code = details.code;
    this.signal = details.signal;
    this.stderr = details.stderr ?? "";
    this.stdout = details.stdout ?? "";
    this.timedOut = details.timedOut === true;
  }
}

function runCommand({ args, command, label, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: COMMAND_OUTPUT_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stderr: stderr ?? "", stdout: stdout ?? "" });
          return;
        }

        reject(
          new MacNotarizationCommandError(`${label} failed.`, {
            code: error.code,
            signal: error.signal,
            stderr,
            stdout,
            timedOut: error.killed === true && error.signal === "SIGTERM",
          }),
        );
      },
    );
  });
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function parseJsonOutput(result, label) {
  const candidates = [result.stdout?.trim(), result.stderr?.trim(), combinedOutput(result)].filter(
    Boolean,
  );
  for (const output of candidates) {
    try {
      return JSON.parse(output);
    } catch {
      // Keep trying because Apple tools occasionally emit diagnostics on stderr.
    }
  }
  throw new Error(`${label} returned invalid JSON.`);
}

function normalizeNotarizationStatus(status) {
  return String(status ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z]/g, "");
}

function resolveCredentials(environment) {
  const credentials = {
    issuer: environment.APPLE_API_ISSUER,
    keyId: environment.APPLE_API_KEY_ID,
    keyPath: environment.APPLE_API_KEY,
  };
  const missing = Object.entries(credentials)
    .filter(([, value]) => typeof value !== "string" || value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Signed macOS notarization is missing credentials: ${missing.join(", ")}.`);
  }
  return credentials;
}

function authorizationArgs(credentials) {
  return [
    "--key",
    credentials.keyPath,
    "--key-id",
    credentials.keyId,
    "--issuer",
    credentials.issuer,
  ];
}

function redactText(value, credentials) {
  let redacted = String(value ?? "");
  for (const secret of [credentials.keyPath, credentials.keyId, credentials.issuer]) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function serializeError(error, credentials) {
  if (!(error instanceof Error)) {
    return { message: redactText(error, credentials), name: "UnknownError" };
  }
  return {
    name: error.name,
    message: redactText(error.message, credentials),
    ...(error.code === undefined ? {} : { code: String(error.code) }),
    ...(error.signal === undefined ? {} : { signal: String(error.signal) }),
    ...(error.timedOut === true ? { timedOut: true } : {}),
    ...(error.stderr ? { stderr: redactText(error.stderr, credentials) } : {}),
    ...(error.stdout ? { stdout: redactText(error.stdout, credentials) } : {}),
  };
}

function signatureField(details, field) {
  return details.match(new RegExp(`^${field}=(.+)$`, "m"))?.[1]?.trim() ?? null;
}

function assertReleaseSignature(details, expectedIdentifier, expectedTeamIdentifier) {
  const identifier = signatureField(details, "Identifier");
  const teamIdentifier = signatureField(details, "TeamIdentifier");
  if (
    identifier !== expectedIdentifier ||
    !details.includes("Authority=Developer ID Application:") ||
    !details.includes("Timestamp=") ||
    !details.includes("runtime") ||
    !teamIdentifier ||
    teamIdentifier === "not set" ||
    (expectedTeamIdentifier && teamIdentifier !== expectedTeamIdentifier)
  ) {
    throw new Error(`macOS release identity verification failed for ${expectedIdentifier}.`);
  }
  return teamIdentifier;
}

function hasEnabledEntitlement(entitlements, entitlement) {
  const keyIndex = entitlements.indexOf(`<key>${entitlement}</key>`);
  if (keyIndex < 0) return false;
  return /<true\s*\/>/.test(entitlements.slice(keyIndex, keyIndex + 256));
}

async function verifySignedApp(appPath, run, timeouts) {
  await run({
    command: "/usr/bin/codesign",
    args: ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    label: "macOS app signature verification",
    timeoutMs: timeouts.commandMs,
  });
  const appDetails = combinedOutput(
    await run({
      command: "/usr/bin/codesign",
      args: ["-dv", "--verbose=4", appPath],
      label: "macOS app identity inspection",
      timeoutMs: timeouts.commandMs,
    }),
  );
  const teamIdentifier = assertReleaseSignature(appDetails, SCIENT_MAC_BUNDLE_IDENTIFIER, null);
  const appEntitlements = combinedOutput(
    await run({
      command: "/usr/bin/codesign",
      args: ["-d", "--entitlements", ":-", appPath],
      label: "macOS app entitlement inspection",
      timeoutMs: timeouts.commandMs,
    }),
  );
  if (hasEnabledEntitlement(appEntitlements, "com.apple.security.get-task-allow")) {
    throw new Error("macOS release app must not enable com.apple.security.get-task-allow.");
  }

  const helperPath = join(appPath, SCIENT_APPSNAP_HELPER_BUNDLE_PATH);
  await run({
    command: "/usr/bin/codesign",
    args: ["--verify", "--strict", "--verbose=4", helperPath],
    label: "AppSnap signature verification",
    timeoutMs: timeouts.commandMs,
  });
  const helperDetails = combinedOutput(
    await run({
      command: "/usr/bin/codesign",
      args: ["-dv", "--verbose=4", helperPath],
      label: "AppSnap identity inspection",
      timeoutMs: timeouts.commandMs,
    }),
  );
  assertReleaseSignature(helperDetails, SCIENT_APPSNAP_HELPER_IDENTIFIER, teamIdentifier);

  for (const electronHelper of SCIENT_ELECTRON_HELPERS) {
    const electronHelperPath = join(appPath, electronHelper.bundlePath);
    await run({
      command: "/usr/bin/codesign",
      args: ["--verify", "--strict", "--verbose=4", electronHelperPath],
      label: `Electron helper signature verification (${electronHelper.identifier})`,
      timeoutMs: timeouts.commandMs,
    });
    const electronHelperDetails = combinedOutput(
      await run({
        command: "/usr/bin/codesign",
        args: ["-dv", "--verbose=4", electronHelperPath],
        label: `Electron helper identity inspection (${electronHelper.identifier})`,
        timeoutMs: timeouts.commandMs,
      }),
    );
    assertReleaseSignature(electronHelperDetails, electronHelper.identifier, teamIdentifier);
    const electronHelperEntitlements = combinedOutput(
      await run({
        command: "/usr/bin/codesign",
        args: ["-d", "--entitlements", ":-", electronHelperPath],
        label: `Electron helper entitlement inspection (${electronHelper.identifier})`,
        timeoutMs: timeouts.commandMs,
      }),
    );
    if (hasEnabledEntitlement(electronHelperEntitlements, "com.apple.security.get-task-allow")) {
      throw new Error(`Electron helper ${electronHelper.identifier} enables get-task-allow.`);
    }
  }
  return teamIdentifier;
}

function historyEntries(history) {
  if (Array.isArray(history)) return history;
  if (Array.isArray(history?.history)) return history.history;
  return [];
}

function findMatchingHistorySubmission(history, archiveName, submittedAtMs) {
  const earliestAcceptedDate = submittedAtMs - 5 * 60 * 1000;
  return historyEntries(history)
    .filter((entry) => {
      const createdAt = Date.parse(entry?.createdDate ?? "");
      return (
        entry?.name === archiveName &&
        typeof entry?.id === "string" &&
        Number.isFinite(createdAt) &&
        createdAt >= earliestAcceptedDate
      );
    })
    .toSorted((left, right) => Date.parse(right.createdDate) - Date.parse(left.createdDate))[0];
}

function statusLabel(status) {
  return typeof status === "string" && status.trim() ? status.trim() : "Unknown";
}

async function retrieveNotarizationLog({ authArgs, run, sleep, submissionId, timeouts }) {
  let lastError;
  for (let attempt = 1; attempt <= timeouts.logAttempts; attempt += 1) {
    try {
      return await run({
        command: "/usr/bin/xcrun",
        args: ["notarytool", "log", submissionId, ...authArgs],
        label: "Apple notarization log retrieval",
        timeoutMs: timeouts.commandMs,
      });
    } catch (error) {
      lastError = error;
      if (attempt < timeouts.logAttempts) await sleep(Math.min(timeouts.pollIntervalMs, 5_000));
    }
  }
  throw lastError;
}

function defaultFileOperations() {
  return {
    createTempDirectory: () => mkdtempSync(join(tmpdir(), "scient-notarization-")),
    ensureDirectory: (directory) => mkdirSync(directory, { recursive: true }),
    fileExists: existsSync,
    removeDirectory: (directory) => rmSync(directory, { force: true, recursive: true }),
    writeFileAtomically(filePath, contents) {
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, filePath);
    },
  };
}

async function runMacNotarization(input, dependencies = {}) {
  const environment = input.environment ?? process.env;
  const credentials = resolveCredentials(environment);
  const fileOperations = dependencies.fileOperations ?? defaultFileOperations();
  const run = dependencies.runCommand ?? runCommand;
  const sleep =
    dependencies.sleep ??
    ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...dependencies.timeouts };
  const authArgs = authorizationArgs(credentials);
  const archiveName = `Scient-${input.arch}-${createId()}.zip`;
  const evidenceFileName = `notarization-evidence-${input.arch}.json`;
  const logFileName = `notarization-log-${input.arch}.json`;
  const evidencePath = join(input.evidenceDirectory, evidenceFileName);
  const logPath = join(input.evidenceDirectory, logFileName);
  const submittedAtMs = now();
  const evidence = {
    schemaVersion: 1,
    product: {
      architecture: input.arch,
      bundleIdentifier: SCIENT_MAC_BUNDLE_IDENTIFIER,
      commit: input.commit ?? null,
      name: input.productName,
      version: input.version ?? null,
    },
    signing: {
      preflight: "pending",
      teamIdentifier: null,
    },
    notarization: {
      archiveName,
      completedAt: null,
      logFile: null,
      pollCount: 0,
      recoveredFromHistory: false,
      status: "Preparing",
      submissionId: null,
      submittedAt: new Date(submittedAtMs).toISOString(),
    },
    verification: {
      gatekeeper: "pending",
      stapled: false,
    },
    error: null,
  };

  const persistEvidence = () => {
    fileOperations.ensureDirectory(input.evidenceDirectory);
    fileOperations.writeFileAtomically(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  };

  let temporaryDirectory;
  try {
    if (!fileOperations.fileExists(credentials.keyPath)) {
      throw new Error("Apple API key file does not exist.");
    }
    persistEvidence();

    evidence.signing.teamIdentifier = await verifySignedApp(input.appPath, run, timeouts);
    evidence.signing.preflight = "passed";
    evidence.notarization.status = "Archiving";
    persistEvidence();

    temporaryDirectory = fileOperations.createTempDirectory();
    const archivePath = join(temporaryDirectory, archiveName);
    await run({
      command: "/usr/bin/ditto",
      args: ["-c", "-k", "--sequesterRsrc", "--keepParent", input.appPath, archivePath],
      label: "macOS notarization archive creation",
      timeoutMs: timeouts.commandMs,
    });

    evidence.notarization.status = "Submitting";
    persistEvidence();
    let submission;
    try {
      submission = parseJsonOutput(
        await run({
          command: "/usr/bin/xcrun",
          args: [
            "notarytool",
            "submit",
            archivePath,
            ...authArgs,
            "--no-wait",
            "--output-format",
            "json",
          ],
          label: "Apple notarization submission",
          timeoutMs: timeouts.submitMs,
        }),
        "Apple notarization submission",
      );
    } catch (submitError) {
      evidence.notarization.submitError = serializeError(submitError, credentials);
      evidence.notarization.status = "Recovering submission ID";
      persistEvidence();
      await sleep(timeouts.historyRecoveryDelayMs);
      const history = parseJsonOutput(
        await run({
          command: "/usr/bin/xcrun",
          args: ["notarytool", "history", ...authArgs, "--output-format", "json"],
          label: "Apple notarization history recovery",
          timeoutMs: timeouts.commandMs,
        }),
        "Apple notarization history",
      );
      const recovered = findMatchingHistorySubmission(history, archiveName, submittedAtMs);
      if (!recovered) throw submitError;
      submission = recovered;
      evidence.notarization.recoveredFromHistory = true;
    }

    if (typeof submission?.id !== "string" || submission.id.length === 0) {
      throw new Error("Apple notarization submission did not return a submission ID.");
    }
    const submissionId = submission.id;
    evidence.notarization.submissionId = submissionId;
    evidence.notarization.status = statusLabel(submission.status ?? "In Progress");
    persistEvidence();
    console.log(`Apple notarization submission created: ${submissionId}`);

    const processingDeadline = now() + timeouts.processingMs;
    let consecutivePollErrors = 0;
    let terminalStatus;
    while (now() < processingDeadline) {
      try {
        const info = parseJsonOutput(
          await run({
            command: "/usr/bin/xcrun",
            args: ["notarytool", "info", submissionId, ...authArgs, "--output-format", "json"],
            label: "Apple notarization status check",
            timeoutMs: timeouts.commandMs,
          }),
          "Apple notarization status",
        );
        consecutivePollErrors = 0;
        evidence.notarization.pollCount += 1;
        evidence.notarization.status = statusLabel(info.status);
        persistEvidence();
        console.log(
          `Apple notarization ${submissionId}: ${evidence.notarization.status} (poll ${evidence.notarization.pollCount})`,
        );
        const normalizedStatus = normalizeNotarizationStatus(info.status);
        if (["accepted", "invalid", "rejected"].includes(normalizedStatus)) {
          terminalStatus = normalizedStatus;
          break;
        }
      } catch (pollError) {
        consecutivePollErrors += 1;
        evidence.notarization.lastPollError = serializeError(pollError, credentials);
        persistEvidence();
        if (consecutivePollErrors >= timeouts.pollErrorLimit) throw pollError;
      }

      const remainingMs = processingDeadline - now();
      if (remainingMs > 0) await sleep(Math.min(timeouts.pollIntervalMs, remainingMs));
    }

    if (!terminalStatus) {
      throw new Error(
        `Apple notarization did not finish within ${Math.round(timeouts.processingMs / 60_000)} minutes; submission ${submissionId} remains available for inspection.`,
      );
    }

    const notarizationLog = await retrieveNotarizationLog({
      authArgs,
      run,
      sleep,
      submissionId,
      timeouts,
    });
    fileOperations.writeFileAtomically(logPath, `${combinedOutput(notarizationLog)}\n`);
    evidence.notarization.logFile = logFileName;
    evidence.notarization.completedAt = new Date(now()).toISOString();
    persistEvidence();

    if (terminalStatus !== "accepted") {
      throw new Error(
        `Apple notarization returned ${evidence.notarization.status} for submission ${submissionId}.`,
      );
    }

    await run({
      command: "/usr/bin/xcrun",
      args: ["stapler", "staple", "--verbose", input.appPath],
      label: "Apple notarization ticket stapling",
      timeoutMs: timeouts.commandMs,
    });
    await run({
      command: "/usr/bin/xcrun",
      args: ["stapler", "validate", "--verbose", input.appPath],
      label: "Apple notarization ticket validation",
      timeoutMs: timeouts.commandMs,
    });
    evidence.verification.stapled = true;
    await run({
      command: "/usr/sbin/spctl",
      args: ["--assess", "--type", "execute", "--verbose=4", input.appPath],
      label: "Gatekeeper assessment",
      timeoutMs: timeouts.commandMs,
    });
    evidence.verification.gatekeeper = "accepted";
    evidence.notarization.status = "Accepted";
    persistEvidence();
    return { evidencePath, logPath, submissionId };
  } catch (error) {
    evidence.error = serializeError(error, credentials);
    evidence.notarization.failedAt = new Date(now()).toISOString();
    persistEvidence();
    throw error;
  } finally {
    if (temporaryDirectory) fileOperations.removeDirectory(temporaryDirectory);
  }
}

module.exports = {
  DEFAULT_TIMEOUTS,
  MacNotarizationCommandError,
  assertReleaseSignature,
  findMatchingHistorySubmission,
  normalizeNotarizationStatus,
  redactText,
  runMacNotarization,
};

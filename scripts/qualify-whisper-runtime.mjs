#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- standalone CLI runtime detection. */
// Qualifies a staged or packaged whisper.cpp runtime: its receipt matches the
// pinned build, a Windows runtime needs nothing Windows lacks, and it
// transcribes a known recording through the app's own runtime owner.
//
//   node scripts/qualify-whisper-runtime.mjs <runtime-directory>

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { LocalWhisperRuntime } from "../packages/scient-voice/src/whisperRuntime.ts";
import {
  assertWindowsRuntimeSelfContained,
  downloadVerified,
  isStagedWhisperRuntime,
  WHISPER_CPP_COMMIT,
} from "./stage-whisper-runtime.ts";

/** The smallest English model, from the revision the app's model manifest pins. */
export const QUALIFICATION_MODEL = {
  fileName: "ggml-tiny.en-q5_1.bin",
  sha256: "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en-q5_1.bin?download=true",
};

/** 11 seconds of 16 kHz mono speech from the pinned whisper.cpp source. */
export const QUALIFICATION_RECORDING = {
  fileName: "jfk.wav",
  sha256: "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
  url: `https://raw.githubusercontent.com/ggml-org/whisper.cpp/${WHISPER_CPP_COMMIT}/samples/jfk.wav`,
};

export const EXPECTED_PHRASE = "ask not what your country can do for you";

export function normalizeTranscript(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hostPlatform() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

/**
 * Records what the runtime owner's server and requests did, for a failure to explain itself:
 * when each phase started and ended, how the server exited, and the end of its output.
 */
export function traceRuntime({ spawn = NodeChildProcess.spawn, fetch = globalThis.fetch } = {}) {
  const startedAt = performance.now();
  const at = () => `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
  const events = [];
  let output = "";
  return {
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      events.push(`${at()} spawned server (pid ${child.pid ?? "none"})`);
      const keep = (chunk) => {
        output = (output + chunk).slice(-8192);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.once("exit", (code, signal) =>
        events.push(`${at()} server exited (code ${code}, signal ${signal})`),
      );
      return child;
    },
    async fetch(url, init) {
      const request = `${init?.method ?? "GET"} ${new URL(url).pathname.split("/").pop()}`;
      const sent = at();
      try {
        const response = await fetch(url, init);
        events.push(`${sent} → ${at()} ${request}: ${response.status}`);
        return response;
      } catch (error) {
        events.push(`${sent} → ${at()} ${request}: ${error instanceof Error ? error.name : error}`);
        throw error;
      }
    },
    report() {
      // Readiness polls every 100 ms; keep the first and last few.
      const shown =
        events.length > 24 ? [...events.slice(0, 8), "…", ...events.slice(-16)] : events;
      return [
        `[voice-qualify] ${NodeOS.cpus().length} CPUs, ${Math.round(NodeOS.freemem() / 2 ** 20)} MiB free`,
        ...shown.map((event) => `[voice-qualify] ${event}`),
        "[voice-qualify] Server output (last 8 KiB):",
        output.trimEnd() || "(none)",
      ].join("\n");
    },
  };
}

async function qualify(runtimeDirectory) {
  const platform = hostPlatform();
  const directory = NodePath.resolve(runtimeDirectory);
  // A universal macOS runtime records its own architecture.
  const recordedArch = await NodeFSP.readFile(NodePath.join(directory, "provenance.json"), "utf8")
    .then((text) => JSON.parse(text).arch)
    .catch(() => undefined);
  const arch = platform === "mac" && recordedArch === "universal" ? "universal" : process.arch;
  // Packaging may sign the files after staging, so their bytes are not compared.
  if (!(await isStagedWhisperRuntime(directory, platform, arch, "names"))) {
    throw new Error(
      `${directory} is not the pinned ${platform}/${arch} runtime: its receipt or file list does not match.`,
    );
  }
  if (platform === "win") await assertWindowsRuntimeSelfContained(directory);

  const workspace = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-voice-qualify-"));
  const trace = traceRuntime();
  const runtime = new LocalWhisperRuntime({
    runtimeDirectory: directory,
    idleTimeoutMs: 60_000,
    spawnImpl: trace.spawn,
    fetchImpl: trace.fetch,
  });
  try {
    const modelPath = NodePath.join(workspace, QUALIFICATION_MODEL.fileName);
    const recordingPath = NodePath.join(workspace, QUALIFICATION_RECORDING.fileName);
    await downloadVerified(QUALIFICATION_MODEL, modelPath);
    await downloadVerified(QUALIFICATION_RECORDING, recordingPath);
    const startedAt = performance.now();
    const result = await runtime.transcribe(
      modelPath,
      {
        audioBytes: await NodeFSP.readFile(recordingPath),
        mimeType: "audio/wav",
        sampleRateHz: 16_000,
        durationMs: 11_000,
      },
      { signal: AbortSignal.timeout(5 * 60_000), language: "en" },
    );
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    console.log(`[voice-qualify] Transcribed in ${seconds} s: ${result.text.trim()}`);
    if (!normalizeTranscript(result.text).includes(EXPECTED_PHRASE)) {
      throw new Error(`The transcript does not contain "${EXPECTED_PHRASE}".`);
    }
  } catch (error) {
    // Only the reference recording runs here, so the server's own output is safe to show.
    console.error(trace.report());
    throw error;
  } finally {
    await runtime.dispose();
    await NodeFSP.rm(workspace, { recursive: true, force: true });
  }
}

const isEntrypoint =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const [directory] = process.argv.slice(2);
  if (!directory) {
    console.error("usage: node scripts/qualify-whisper-runtime.mjs <runtime-directory>");
    process.exitCode = 2;
  } else {
    qualify(directory).then(
      () => console.log("[voice-qualify] The runtime transcribes the reference recording."),
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
  }
}

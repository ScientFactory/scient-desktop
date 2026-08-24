import { describe, expect, it } from "vite-plus/test";

import { buildAgySessionArgs } from "../../provider/antigravity/AgySession.ts";
import { buildClaudeVoiceTranscriptCorrectionArgs } from "./ClaudeVoiceTranscriptCorrection.ts";
import { buildCodexVoiceTranscriptCorrectionArgs } from "./CodexVoiceTranscriptCorrection.ts";

describe("voice transcript correction provider commands", () => {
  it("runs Codex ephemerally without tools or writable workspace access", () => {
    const args = buildCodexVoiceTranscriptCorrectionArgs({
      model: "gpt-5.6",
      schemaPath: "/tmp/schema.json",
      outputPath: "/tmp/output.json",
      launchArgs: ["--strict-config", "--enable", "shell_tool"],
    });

    expect(args.slice(1, 4)).toEqual(["--strict-config", "--enable", "shell_tool"]);
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("read-only");
    expect(args.filter((arg) => arg === "--disable")).toHaveLength(7);
    expect(args.lastIndexOf("shell_tool")).toBeGreaterThan(args.indexOf("shell_tool"));
    expect(args.at(args.lastIndexOf("shell_tool") - 1)).toBe("--disable");
  });

  it("runs Claude without tools, persistence, Chrome, or permission prompts", () => {
    const args = buildClaudeVoiceTranscriptCorrectionArgs({
      model: "claude-sonnet-4-6",
      jsonSchema: "{}",
      effort: "low",
    });

    expect(args).toContain("--safe-mode");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "low",
    ]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
  });

  it("runs Antigravity in its sandbox without full-access permission bypass", () => {
    const args = buildAgySessionArgs({
      binaryPath: "agy",
      cwd: "/tmp/voice",
      environment: {},
      model: "gemini-3.7-flash",
      effort: "low",
      runtimeMode: "approval-required",
      printTimeout: "10s",
      jsonSchema: "{}",
      sandbox: true,
    });

    expect(args).toContain("--sandbox");
    expect(args).toContain("10s");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

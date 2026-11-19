import { ProviderDriverKind, type ServerProviderSlashCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  codexOpenAiFeedbackText,
  parseScientFeedbackCommand,
  renameCodexFeedbackCommand,
} from "./feedbackSlashCommand";

const codex = ProviderDriverKind.make("codex");

describe("/feedback", () => {
  it("reads the words after the command as the message", () => {
    expect(parseScientFeedbackCommand("/feedback")).toEqual({ message: "" });
    expect(parseScientFeedbackCommand("  /Feedback  the export lost my figures \n")).toEqual({
      message: "the export lost my figures",
    });
    expect(parseScientFeedbackCommand("/feedback line one\nline two")).toEqual({
      message: "line one\nline two",
    });
  });

  it("leaves other text and Codex's OpenAI command alone", () => {
    expect(parseScientFeedbackCommand("please /feedback")).toBeNull();
    expect(parseScientFeedbackCommand("/feedbacks")).toBeNull();
    expect(parseScientFeedbackCommand("/feedback-openai broken")).toBeNull();
  });

  it("turns /feedback-openai into the /feedback text Codex's upload reads", () => {
    expect(codexOpenAiFeedbackText("/feedback-openai")).toBe("/feedback");
    expect(codexOpenAiFeedbackText("/feedback-openai the tool hung")).toBe(
      "/feedback the tool hung",
    );
    expect(codexOpenAiFeedbackText("/feedback the tool hung")).toBeNull();
    expect(codexOpenAiFeedbackText("/feedback-openaix")).toBeNull();
  });

  it("renames only Codex's /feedback, and only beside Scient's", () => {
    const codexFeedback: ServerProviderSlashCommand = {
      name: "feedback",
      description: "Send this thread and Codex logs to OpenAI",
    };
    expect(renameCodexFeedbackCommand(codex, codexFeedback, true)).toEqual({
      ...codexFeedback,
      name: "feedback-openai",
    });
    expect(renameCodexFeedbackCommand(codex, codexFeedback, false)).toBe(codexFeedback);
    expect(
      renameCodexFeedbackCommand(ProviderDriverKind.make("claudeAgent"), codexFeedback, true),
    ).toBe(codexFeedback);
    const goal: ServerProviderSlashCommand = { name: "goal" };
    expect(renameCodexFeedbackCommand(codex, goal, true)).toBe(goal);
  });
});

import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  QuickChatTaskRequiredError,
  validateQuickChatCreation,
} from "./quickChatCreationValidation";

describe("Quick Chat creation validation", () => {
  const environmentId = EnvironmentId.make("environment-local");

  it("returns a structured failure for an empty task", () => {
    const error = validateQuickChatCreation({ environmentId, initialMessageText: "  " });
    expect(error).toBeInstanceOf(QuickChatTaskRequiredError);
    expect(error).toMatchObject({
      _tag: "QuickChatTaskRequiredError",
      environmentId,
      message: "Enter a task before starting the thread.",
    });
  });

  it("accepts a non-empty task", () => {
    expect(validateQuickChatCreation({ environmentId, initialMessageText: "Explore this" })).toBe(
      null,
    );
  });
});

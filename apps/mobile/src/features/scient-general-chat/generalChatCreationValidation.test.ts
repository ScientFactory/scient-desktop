import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  GeneralChatTaskRequiredError,
  validateGeneralChatCreation,
} from "./generalChatCreationValidation";

describe("General Chat creation validation", () => {
  const environmentId = EnvironmentId.make("environment-local");

  it("returns a structured failure for an empty task", () => {
    const error = validateGeneralChatCreation({ environmentId, initialMessageText: "  " });
    expect(error).toBeInstanceOf(GeneralChatTaskRequiredError);
    expect(error).toMatchObject({
      _tag: "GeneralChatTaskRequiredError",
      environmentId,
      message: "Enter a task before starting the thread.",
    });
  });

  it("accepts a non-empty task", () => {
    expect(validateGeneralChatCreation({ environmentId, initialMessageText: "Explore this" })).toBe(
      null,
    );
  });
});

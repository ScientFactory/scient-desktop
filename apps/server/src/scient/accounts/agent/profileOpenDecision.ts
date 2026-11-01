import type { ProfileResult } from "./profileClassification.ts";

export function profileOpenDecision(
  result: typeof ProfileResult.Type,
  options: {
    operation: "open" | "navigate";
    explicitProfile: boolean;
    targetsExistingTab: boolean;
  },
) {
  if (result !== "denied" && result !== "sign-in") return { action: "nothing" } as const;
  const problem = result === "denied" ? "access denied" : "a sign-in page";
  if (options.operation === "navigate" || options.explicitProfile || options.targetsExistingTab)
    return { action: "note", problem } as const;
  return { action: "switch", problem } as const;
}

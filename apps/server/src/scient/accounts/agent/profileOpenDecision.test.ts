import { expect, it } from "vite-plus/test";
import { profileOpenDecision } from "./profileOpenDecision.ts";

const automatic = { operation: "open", explicitProfile: false, targetsExistingTab: false } as const;

it.each([
  { name: "accessible page", result: "opens", options: automatic, expected: { action: "nothing" } },
  {
    name: "denied new tab without a selected profile",
    result: "denied",
    options: automatic,
    expected: { action: "switch", problem: "access denied" },
  },
  {
    name: "sign-in on a new tab without a selected profile",
    result: "sign-in",
    options: automatic,
    expected: { action: "switch", problem: "a sign-in page" },
  },
  {
    name: "navigation preserves its tab",
    result: "denied",
    options: { ...automatic, operation: "navigate" },
    expected: { action: "note", problem: "access denied" },
  },
  {
    name: "explicit profile choice is preserved",
    result: "denied",
    options: { ...automatic, explicitProfile: true },
    expected: { action: "note", problem: "access denied" },
  },
  {
    name: "existing tab is preserved",
    result: "denied",
    options: { ...automatic, targetsExistingTab: true },
    expected: { action: "note", problem: "access denied" },
  },
] satisfies ReadonlyArray<{
  name: string;
  result: Parameters<typeof profileOpenDecision>[0];
  options: Parameters<typeof profileOpenDecision>[1];
  expected: ReturnType<typeof profileOpenDecision>;
}>)("$name", ({ result, options, expected }) => {
  expect(profileOpenDecision(result, options)).toEqual(expected);
});

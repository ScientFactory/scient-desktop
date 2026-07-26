// FILE: gitActionAuthority.ts
// Purpose: Defines live Git mutation authority without changing released migration dependencies.
// Layer: Runtime transport contracts

import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import { GitPullInput, GitRunStackedActionInput } from "./git";

export const AuthorizedGitPullInput = Schema.Struct({
  ...GitPullInput.fields,
  expectedBranch: TrimmedNonEmptyString,
});
export type AuthorizedGitPullInput = typeof AuthorizedGitPullInput.Type;

export const AuthorizedGitRunStackedActionInput = Schema.Struct({
  ...GitRunStackedActionInput.fields,
  expectedBranch: TrimmedNonEmptyString,
});
export type AuthorizedGitRunStackedActionInput = typeof AuthorizedGitRunStackedActionInput.Type;

import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

const RepositoryReference = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const ProjectSourcePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

export const RepositoryProvider = Schema.Literals(["github", "gitlab"]);
export type RepositoryProvider = typeof RepositoryProvider.Type;

export const RepositorySourceStatus = Schema.Struct({
  provider: RepositoryProvider,
  status: Schema.Literals(["available", "setup-required"]),
  message: TrimmedNonEmptyString,
});
export type RepositorySourceStatus = typeof RepositorySourceStatus.Type;

export const RepositorySourceStatusesResult = Schema.Struct({
  sources: Schema.Array(RepositorySourceStatus),
});
export type RepositorySourceStatusesResult = typeof RepositorySourceStatusesResult.Type;

export const CloneProjectSourceInput = Schema.Struct({
  source: Schema.Literals(["git-url", "github", "gitlab"]),
  remoteUrl: Schema.optional(ProjectSourcePath),
  repository: Schema.optional(RepositoryReference),
  destinationPath: ProjectSourcePath,
});
export type CloneProjectSourceInput = typeof CloneProjectSourceInput.Type;

export const CloneProjectSourceResult = Schema.Struct({
  path: ProjectSourcePath,
});
export type CloneProjectSourceResult = typeof CloneProjectSourceResult.Type;

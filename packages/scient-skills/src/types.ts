export const SCIENT_BUILT_IN_ORIGIN = "scient:builtin" as const;
export const SCIENT_SKILLS_LOCK_FORMAT_VERSION = 1 as const;

export type BuiltInSkillKind = "scientific" | "meta";
export type BuiltInSkillRole = "constructive" | "review" | "orientation";
export type BuiltInSkillScope = "universal" | "domain";
export type BuiltInSkillVisibility = "internal" | "user";
export type BuiltInSkillActivationScope = "user" | "project";
export type BuiltInSkillProjectWrites = "none" | "proposal-only";

export interface BuiltInSkillMetadata {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly kind: BuiltInSkillKind;
  readonly role: BuiltInSkillRole;
  readonly scope: BuiltInSkillScope;
  readonly visibility: BuiltInSkillVisibility;
  readonly activation: {
    readonly scope: BuiltInSkillActivationScope;
    readonly defaultEnabled: boolean;
  };
  readonly maintainer: string;
  readonly capabilities: {
    readonly network: boolean;
    readonly codeExecution: boolean;
    readonly projectWrites: BuiltInSkillProjectWrites;
  };
  readonly requirements: {
    readonly projectObjects: readonly string[];
    readonly operations: readonly string[];
  };
  readonly limitations: readonly string[];
}

export interface BuiltInSkillRelease extends BuiltInSkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly origin: typeof SCIENT_BUILT_IN_ORIGIN;
  readonly digest: `sha256:${string}`;
  readonly body: string;
}

export interface BuiltInSkillActivation {
  readonly id: string;
  readonly version: string;
  readonly digest: `sha256:${string}`;
  readonly origin: typeof SCIENT_BUILT_IN_ORIGIN;
}

export interface BuiltInSkillsLock {
  readonly formatVersion: typeof SCIENT_SKILLS_LOCK_FORMAT_VERSION;
  readonly skills: readonly BuiltInSkillActivation[];
}

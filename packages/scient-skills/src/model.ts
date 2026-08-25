export const SCIENT_SKILL_MANIFEST_FILE = "scient.skill.json";
export const SKILL_DOCUMENT_FILE = "SKILL.md";
export const SCIENT_SKILLS_LOCK_FILE = ".scient/skills.lock.json";

export type SkillActivationScope = "project" | "user";

/** Whether an active skill may be selected by the agent or only by the user. */
export type SkillInvocationPolicy = "automatic" | "explicit";

export type SkillOrigin =
  | { readonly kind: "scient" }
  | {
      readonly kind: "addon";
      readonly addonId: string;
      readonly addonVersion: string;
    };

export interface SkillReleaseManifest {
  readonly apiVersion: "scient.skills/v1alpha1";
  readonly id: string;
  readonly version: string;
  readonly category: string;
  readonly categoryDescription: string;
  readonly displayOrder: number;
  /** Activation is user/project policy, not release provenance. */
  readonly supportedScopes: ReadonlyArray<SkillActivationScope>;
  readonly defaultInvocationPolicy: SkillInvocationPolicy;
  readonly origin: SkillOrigin;
}

export interface AgentSkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Informational only. Scient never turns this experimental field into authority. */
  readonly allowedTools?: string;
}

export interface SkillResourceSummary {
  readonly path: string;
  readonly bytes: number;
  readonly kind: "asset" | "reference" | "script" | "other";
}

export interface SkillReleaseRef {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly origin: string;
}

export interface SkillReleaseSummary extends SkillReleaseRef {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly categoryDescription: string;
  readonly displayOrder: number;
  readonly supportedScopes: ReadonlyArray<SkillActivationScope>;
  readonly defaultInvocationPolicy: SkillInvocationPolicy;
}

export interface SkillRelease extends SkillReleaseSummary {
  readonly manifest: SkillReleaseManifest;
  readonly metadata: AgentSkillMetadata;
  readonly instructions: string;
  readonly resources: ReadonlyArray<SkillResourceSummary>;
}

export function skillOriginKey(origin: SkillOrigin): string {
  return origin.kind === "scient" ? "scient" : `addon:${origin.addonId}@${origin.addonVersion}`;
}

export function skillReleaseKey(release: SkillReleaseRef): string {
  return `${release.id}@${release.version}#${release.digest}`;
}

export function toSkillReleaseRef(release: SkillRelease): SkillReleaseRef {
  return {
    id: release.id,
    version: release.version,
    digest: release.digest,
    origin: release.origin,
  };
}

export function toSkillReleaseSummary(release: SkillRelease): SkillReleaseSummary {
  return {
    ...toSkillReleaseRef(release),
    name: release.name,
    description: release.description,
    category: release.category,
    categoryDescription: release.categoryDescription,
    displayOrder: release.displayOrder,
    supportedScopes: release.supportedScopes,
    defaultInvocationPolicy: release.defaultInvocationPolicy,
  };
}

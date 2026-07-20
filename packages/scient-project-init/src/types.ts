export const SCIENT_FORMAT_VERSION = 1;
export const SCIENT_PROJECT_FILE = "PROJECT.md";
export const SCIENT_AGENTS_FILE = "AGENTS.md";
export const SCIENT_METADATA_DIRECTORY = ".scient";
export const SCIENT_IDENTITY_FILE = ".scient/project.json";
export const SCIENT_SKILLS_LOCK_FILE = ".scient/skills.lock.json";
export const SCIENT_TRANSACTION_FILE = ".scient/init-transaction.json";
export const SCIENT_SKILLS_LOCK_FORMAT_VERSION = 1;
export const SCIENT_BUILT_IN_ORIGIN = "scient:builtin";
export const LEGACY_PAPILAB_METADATA_DIRECTORY = ".papilab";
export const LEGACY_PAPILAB_IDENTITY_FILE = ".papilab/project.json";

export type ProjectFolderState =
  | "empty-uninitialized"
  | "existing-uninitialized"
  | "legacy-papilab-compatible"
  | "initialized-compatible"
  | "partially-initialized"
  | "invalid-or-conflicting";

export type PathSnapshot =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly sha256: string; readonly size: number }
  | { readonly kind: "directory" }
  | { readonly kind: "symlink"; readonly target: string }
  | { readonly kind: "other" };

export interface ScientProjectIdentity {
  readonly projectId: string;
  readonly formatVersion: typeof SCIENT_FORMAT_VERSION;
  readonly createdAt: string;
}

export interface InspectionIssue {
  readonly code:
    | "empty-metadata-directory"
    | "incomplete-transaction"
    | "invalid-identity"
    | "invalid-skills-lock"
    | "invalid-transaction"
    | "metadata-path-conflict"
    | "missing-agents-file"
    | "missing-project-file";
  readonly path: string;
  readonly message: string;
}

export interface ProjectFolderInspection {
  readonly requestedRoot: string;
  readonly root: string;
  readonly state: ProjectFolderState;
  readonly entries: readonly string[];
  readonly projectFile: PathSnapshot;
  readonly agentsFile: PathSnapshot;
  readonly metadataDirectory: PathSnapshot;
  readonly identityFile: PathSnapshot;
  readonly skillsLockFile: PathSnapshot;
  readonly transactionFile: PathSnapshot;
  readonly legacyPapiLabMetadataDirectory: PathSnapshot;
  readonly legacyPapiLabIdentityFile: PathSnapshot;
  readonly legacyPapiLabIdentity: ScientProjectIdentity | null;
  readonly identity: ScientProjectIdentity | null;
  readonly skillsLock: ScientSkillsLock | null;
  readonly issues: readonly InspectionIssue[];
}

export interface InitializationRequest {
  readonly title?: string;
  readonly purpose?: string;
  readonly question?: string;
  readonly scopeIncluded?: string;
  readonly scopeExcluded?: string;
  readonly profileIds?: readonly string[];
  readonly skillIds?: readonly string[];
}

export interface BuiltInSkillActivation {
  readonly id: string;
  readonly version: string;
  readonly digest: `sha256:${string}`;
  readonly origin: typeof SCIENT_BUILT_IN_ORIGIN;
}

export interface BuiltInSkillDescriptor extends BuiltInSkillActivation {
  readonly displayName: string;
  readonly description: string;
  readonly role: "constructive" | "review" | "orientation";
  readonly defaultSelected: boolean;
  readonly readiness: "available" | "latent";
  readonly prerequisites: readonly string[];
  readonly capabilities: {
    readonly network: boolean;
    readonly codeExecution: boolean;
    readonly projectWrites: "none" | "proposal-only";
  };
}

export interface ScientSkillsLock {
  readonly formatVersion: typeof SCIENT_SKILLS_LOCK_FORMAT_VERSION;
  readonly skills: readonly BuiltInSkillActivation[];
}

export interface ProfileSection {
  readonly heading: string;
  readonly prompt?: string;
}

export interface ProfileFile {
  readonly path: string;
  readonly contents: string;
}

export interface ProjectProfileDescriptor {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly projectSections?: readonly ProfileSection[];
  readonly managedAgentInstructions?: readonly string[];
  readonly files?: readonly ProfileFile[];
}

export interface NormalizedInitializationRequest {
  readonly title: string | null;
  readonly purpose: string | null;
  readonly question: string | null;
  readonly scopeIncluded: string | null;
  readonly scopeExcluded: string | null;
  readonly profileIds: readonly string[];
  readonly skillIds: readonly string[];
}

interface PlanOperationBase {
  readonly path: string;
  readonly reason: string;
}

export interface CreateOperation extends PlanOperationBase {
  readonly kind: "create";
  readonly contents: string;
  readonly expected: { readonly kind: "missing" };
}

export interface PreserveOperation extends PlanOperationBase {
  readonly kind: "preserve";
  readonly expected: Exclude<PathSnapshot, { readonly kind: "missing" }>;
}

export interface ProposeOperation extends PlanOperationBase {
  readonly kind: "propose";
  readonly contents: string;
  readonly expected: Extract<PathSnapshot, { readonly kind: "file" }>;
}

export interface ConflictOperation extends PlanOperationBase {
  readonly kind: "conflict";
  readonly observed: PathSnapshot;
}

export type InitializationPlanOperation =
  | CreateOperation
  | PreserveOperation
  | ProposeOperation
  | ConflictOperation;

export interface InitializationPlan {
  readonly planVersion: 1;
  readonly transactionId: string;
  readonly root: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly status: "ready" | "blocked" | "already-initialized";
  readonly request: NormalizedInitializationRequest;
  readonly profileVersions: Readonly<Record<string, number>>;
  readonly skillActivations: readonly BuiltInSkillActivation[];
  readonly operations: readonly InitializationPlanOperation[];
}

export interface InitializationPlanInput {
  readonly inspection: ProjectFolderInspection;
  readonly request: InitializationRequest;
  readonly profiles?: readonly ProjectProfileDescriptor[];
  readonly builtInSkills?: readonly BuiltInSkillDescriptor[];
  readonly projectId?: string;
  readonly transactionId?: string;
  readonly createdAt?: string;
}

export interface InitializationTransaction {
  readonly transactionVersion: 1;
  readonly transactionId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly profileVersions: Readonly<Record<string, number>>;
  readonly skillActivations: readonly BuiltInSkillActivation[];
  readonly operations: readonly (CreateOperation | PreserveOperation | ProposeOperation)[];
}

export interface ApplyStep {
  readonly index: number;
  readonly kind: "marker-written" | "file-created" | "completed";
  readonly path: string;
}

export interface ApplyInitializationOptions {
  readonly onStep?: (step: ApplyStep) => void | Promise<void>;
}

export interface ApplyInitializationResult {
  readonly projectId: string;
  readonly created: readonly string[];
  readonly preserved: readonly string[];
  readonly proposed: readonly string[];
  readonly activatedSkills: readonly BuiltInSkillActivation[];
  readonly recovered: boolean;
}

export interface RollbackInitializationResult {
  readonly complete: boolean;
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
}

export class ProjectInitializationError extends Error {
  readonly code:
    | "APPLY_BLOCKED"
    | "CONCURRENT_CHANGE"
    | "INVALID_FOLDER"
    | "INVALID_IDENTITY"
    | "INVALID_PLAN"
    | "INVALID_PROFILE"
    | "INVALID_REQUEST"
    | "INVALID_TRANSACTION"
    | "PATH_ESCAPE"
    | "RECOVERY_CONFLICT";

  constructor(code: ProjectInitializationError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectInitializationError";
    this.code = code;
  }
}

export {
  applyProjectInitialization,
  recoverProjectInitialization,
  rollbackProjectInitialization,
} from "./apply.ts";
export { inspectProjectFolder } from "./inspect.ts";
export { planProjectInitialization } from "./plan.ts";
export {
  PAPILAB_MANAGED_END,
  PAPILAB_MANAGED_START,
  proposeManagedAgentsContents,
  renderAgentsMarkdown,
  renderManagedAgentsBlock,
  renderProjectMarkdown,
} from "./templates.ts";
export {
  normalizeInitializationRequest,
  resolveSelectedProfiles,
  validatePortableRelativePath,
  validateProfileDescriptor,
  validateProjectIdentity,
} from "./validation.ts";
export {
  PAPILAB_AGENTS_FILE,
  PAPILAB_FORMAT_VERSION,
  PAPILAB_IDENTITY_FILE,
  PAPILAB_METADATA_DIRECTORY,
  PAPILAB_PROJECT_FILE,
  PAPILAB_TRANSACTION_FILE,
  ProjectInitializationError,
} from "./types.ts";
export type {
  ApplyInitializationOptions,
  ApplyInitializationResult,
  ApplyStep,
  ConflictOperation,
  CreateOperation,
  InitializationPlan,
  InitializationPlanInput,
  InitializationPlanOperation,
  InitializationRequest,
  InspectionIssue,
  PapiLabProjectIdentity,
  NormalizedInitializationRequest,
  PathSnapshot,
  PreserveOperation,
  ProfileFile,
  ProfileSection,
  ProjectFolderInspection,
  ProjectFolderState,
  ProjectProfileDescriptor,
  ProposeOperation,
  RollbackInitializationResult,
} from "./types.ts";

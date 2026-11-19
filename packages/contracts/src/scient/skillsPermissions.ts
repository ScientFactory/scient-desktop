import { AuthSettingsWriteScope } from "../auth.ts";
import { SCIENT_SKILL_WS_METHODS as methods } from "./skillRpcs.ts";

/**
 * Personal skills read files and folders on the environment's computer and change the user's
 * skills, so every call needs the settings grant, like connectors' local inspection.
 */
export const SCIENT_SKILL_GUARDED_RPC_SCOPES = {
  [methods.skillsPersonalInspect]: AuthSettingsWriteScope,
  [methods.skillsPersonalAdd]: AuthSettingsWriteScope,
  [methods.skillsPersonalRemove]: AuthSettingsWriteScope,
  [methods.skillsPersonalUndo]: AuthSettingsWriteScope,
  [methods.skillsPersonalExport]: AuthSettingsWriteScope,
  [methods.skillsPersonalImportable]: AuthSettingsWriteScope,
} as const;

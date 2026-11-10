import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  ImportableSkillsResult,
  PersonalSkillAddInput,
  PersonalSkillAddResult,
  PersonalSkillExport,
  PersonalSkillInspectInput,
  PersonalSkillInspection,
  PersonalSkillNameInput,
  ProviderSkillManagementError,
  ProviderSkillReadDocumentInput,
  ProviderSkillDocument,
  ProviderSkillSetEnabledInput,
  ProviderSkillSetEnabledResult,
  ScientSkillDocument,
  ScientSkillInventory,
  ScientSkillListInput,
  ScientSkillManagementError,
  ScientSkillReadDocumentInput,
  ScientSkillSetProjectPreferenceInput,
  ScientSkillSetUserActivationInput,
} from "../scientSkills.ts";

/** Spread into rpc.ts WS_METHODS where these methods have always been listed. */
export const SCIENT_SKILL_WS_METHODS = {
  // Scient-owned reusable skills
  skillsList: "skills.list",
  skillsReadDocument: "skills.readDocument",
  skillsSetProjectPreference: "skills.setProjectPreference",
  skillsSetUserActivation: "skills.setUserActivation",
  providerSkillsReadDocument: "providerSkills.readDocument",
  providerSkillsSetEnabled: "providerSkills.setEnabled",
  // Personal skills: added by the user or by an agent for them
  skillsPersonalInspect: "skills.personal.inspect",
  skillsPersonalAdd: "skills.personal.add",
  skillsPersonalRemove: "skills.personal.remove",
  skillsPersonalUndo: "skills.personal.undo",
  skillsPersonalExport: "skills.personal.export",
  skillsPersonalImportable: "skills.personal.importable",
} as const;

export const WsSkillsListRpc = Rpc.make(SCIENT_SKILL_WS_METHODS.skillsList, {
  payload: ScientSkillListInput,
  success: ScientSkillInventory,
  error: Schema.Union([ScientSkillManagementError, EnvironmentAuthorizationError]),
});

export const WsSkillsReadDocumentRpc = Rpc.make(SCIENT_SKILL_WS_METHODS.skillsReadDocument, {
  payload: ScientSkillReadDocumentInput,
  success: ScientSkillDocument,
  error: Schema.Union([ScientSkillManagementError, EnvironmentAuthorizationError]),
});

export const WsSkillsSetProjectPreferenceRpc = Rpc.make(
  SCIENT_SKILL_WS_METHODS.skillsSetProjectPreference,
  {
    payload: ScientSkillSetProjectPreferenceInput,
    success: ScientSkillInventory,
    error: Schema.Union([ScientSkillManagementError, EnvironmentAuthorizationError]),
  },
);

export const WsSkillsSetUserActivationRpc = Rpc.make(
  SCIENT_SKILL_WS_METHODS.skillsSetUserActivation,
  {
    payload: ScientSkillSetUserActivationInput,
    success: ScientSkillInventory,
    error: Schema.Union([ScientSkillManagementError, EnvironmentAuthorizationError]),
  },
);

export const WsProviderSkillsSetEnabledRpc = Rpc.make(
  SCIENT_SKILL_WS_METHODS.providerSkillsSetEnabled,
  {
    payload: ProviderSkillSetEnabledInput,
    success: ProviderSkillSetEnabledResult,
    error: Schema.Union([ProviderSkillManagementError, EnvironmentAuthorizationError]),
  },
);

export const WsProviderSkillsReadDocumentRpc = Rpc.make(
  SCIENT_SKILL_WS_METHODS.providerSkillsReadDocument,
  {
    payload: ProviderSkillReadDocumentInput,
    success: ProviderSkillDocument,
    error: Schema.Union([ProviderSkillManagementError, EnvironmentAuthorizationError]),
  },
);

const personalError = Schema.Union([ScientSkillManagementError, EnvironmentAuthorizationError]);

/** What a file, folder, web address or pasted text holds: skills, material, or nothing. */
export const WsSkillsPersonalInspectRpc = Rpc.make(SCIENT_SKILL_WS_METHODS.skillsPersonalInspect, {
  payload: PersonalSkillInspectInput,
  success: PersonalSkillInspection,
  error: personalError,
});

export const WsSkillsPersonalAddRpc = Rpc.make(SCIENT_SKILL_WS_METHODS.skillsPersonalAdd, {
  payload: PersonalSkillAddInput,
  success: PersonalSkillAddResult,
  error: personalError,
});

export const WsSkillsPersonalRemoveRpc = Rpc.make(SCIENT_SKILL_WS_METHODS.skillsPersonalRemove, {
  payload: PersonalSkillNameInput,
  success: ScientSkillInventory,
  error: personalError,
});

export const WsSkillsPersonalUndoRpc = Rpc.make(SCIENT_SKILL_WS_METHODS.skillsPersonalUndo, {
  payload: PersonalSkillNameInput,
  success: ScientSkillInventory,
  error: personalError,
});

export const WsSkillsPersonalExportRpc = Rpc.make(SCIENT_SKILL_WS_METHODS.skillsPersonalExport, {
  payload: PersonalSkillNameInput,
  success: PersonalSkillExport,
  error: personalError,
});

export const WsSkillsPersonalImportableRpc = Rpc.make(
  SCIENT_SKILL_WS_METHODS.skillsPersonalImportable,
  {
    payload: Schema.Struct({}),
    success: ImportableSkillsResult,
    error: personalError,
  },
);

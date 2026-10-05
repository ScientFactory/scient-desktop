import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  ProviderSkillManagementError,
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
  providerSkillsSetEnabled: "providerSkills.setEnabled",
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

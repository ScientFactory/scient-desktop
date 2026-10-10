/**
 * Scient's skill RPCs: listing Scient skills for a project or thread
 * workspace, reading a skill, setting project and user activation, and
 * switching provider-native skills on or off.
 *
 * @module SkillRpcHandlers
 */
import {
  type ProjectId,
  ScientSkillManagementError,
  type ThreadId,
  WS_METHODS,
  WsServerManagementRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../../project/ProjectService.ts";
import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import * as ProviderSkillManagement from "./ProviderSkillManagement.ts";
import type { ScientSkillManagementShape } from "./ScientSkillManagement.ts";

export const makeSkillRpcHandlers = ({
  observeRpcEffect,
  threadManagement,
  projectService,
  scientSkillManagement,
  providerRegistry,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly projectService: ProjectService.ProjectService["Service"];
  readonly scientSkillManagement: ScientSkillManagementShape;
  readonly providerRegistry: ProviderRegistryShape;
}) => {
  const skillContextError = (operation: string, message: string) =>
    new ScientSkillManagementError({ operation, message });
  const resolveScientSkillProjectRoot = Effect.fn("ws.resolveScientSkillProjectRoot")(
    function* (input: {
      readonly projectId?: ProjectId | undefined;
      readonly threadId?: ThreadId | undefined;
    }) {
      if (input.threadId) {
        const thread = yield* threadManagement.getThreadShell(input.threadId).pipe(
          Effect.map((thread) => (thread === null ? Option.none() : Option.some(thread))),
          Effect.mapError(() =>
            skillContextError("list", "The thread workspace could not be resolved."),
          ),
        );
        if (Option.isNone(thread)) {
          return yield* skillContextError("list", "That thread is not available.");
        }
        if (input.projectId && thread.value.projectId !== input.projectId) {
          return yield* skillContextError(
            "list",
            "The requested thread does not belong to that project.",
          );
        }
        if (thread.value.worktreePath) return thread.value.worktreePath;
        if (thread.value.projectId) {
          const project = yield* projectService
            .getShell(thread.value.projectId)
            .pipe(
              Effect.mapError(() =>
                skillContextError("list", "The project workspace could not be resolved."),
              ),
            );
          if (Option.isSome(project)) return project.value.workspaceRoot;
        }
        return yield* skillContextError("list", "That thread has no project workspace.");
      }
      if (input.projectId) {
        const project = yield* projectService
          .getShell(input.projectId)
          .pipe(
            Effect.mapError(() =>
              skillContextError("list", "The project workspace could not be resolved."),
            ),
          );
        if (Option.isNone(project)) {
          return yield* skillContextError("list", "That project is not available.");
        }
        return project.value.workspaceRoot;
      }
      return undefined;
    },
  );
  const providerSkillManagement =
    ProviderSkillManagement.makeProviderSkillManagement(providerRegistry);
  return {
    [WS_METHODS.providerSkillsSetEnabled]: (input) =>
      observeRpcEffect(
        WS_METHODS.providerSkillsSetEnabled,
        providerSkillManagement.setEnabled(input),
        { "rpc.aggregate": "skills" },
      ),
    [WS_METHODS.skillsList]: (input) =>
      observeRpcEffect(
        WS_METHODS.skillsList,
        Effect.gen(function* () {
          const projectRoot = yield* resolveScientSkillProjectRoot(input);
          return yield* scientSkillManagement.list(projectRoot);
        }),
        { "rpc.aggregate": "skills" },
      ),
    [WS_METHODS.skillsReadDocument]: (input) =>
      observeRpcEffect(
        WS_METHODS.skillsReadDocument,
        scientSkillManagement.readDocument(input.releaseKey),
        { "rpc.aggregate": "skills" },
      ),
    [WS_METHODS.skillsSetProjectPreference]: (input) =>
      observeRpcEffect(
        WS_METHODS.skillsSetProjectPreference,
        Effect.gen(function* () {
          const projectRoot = yield* resolveScientSkillProjectRoot({
            projectId: input.projectId,
          });
          if (!projectRoot) {
            return yield* skillContextError(
              "setProjectPreference",
              "That project has no workspace.",
            );
          }
          return yield* scientSkillManagement.setProjectPreference({
            projectRoot,
            name: input.name,
            active: input.active,
            invocationPolicy: input.invocationPolicy,
          });
        }),
        { "rpc.aggregate": "skills" },
      ),
    [WS_METHODS.skillsSetUserActivation]: (input) =>
      observeRpcEffect(
        WS_METHODS.skillsSetUserActivation,
        scientSkillManagement.setUserActivation(input),
        { "rpc.aggregate": "skills" },
      ),
  } satisfies ScientRpcHandlerSubset<
    typeof WsServerManagementRpcGroup,
    | typeof WS_METHODS.providerSkillsSetEnabled
    | typeof WS_METHODS.skillsList
    | typeof WS_METHODS.skillsReadDocument
    | typeof WS_METHODS.skillsSetProjectPreference
    | typeof WS_METHODS.skillsSetUserActivation
  >;
};

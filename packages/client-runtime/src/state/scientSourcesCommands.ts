import {
  type ClientGuardedHttpTag,
  type EnvironmentId,
  SCIENT_SOURCES_HTTP_COMMANDS as tags,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import type { Atom } from "effect/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import { mutateEnvironmentAnnotation } from "./scientAnnotationsHttp.ts";
import { resolveEnvironmentReferences } from "./scientReferencesHttp.ts";
import * as http from "./scientSourcesHttp.ts";

const preparedConnection = (environmentId: EnvironmentId) =>
  EnvironmentSupervisor.EnvironmentSupervisor.pipe(
    Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.prepared)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId,
              message: "The selected environment is not connected.",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

/**
 * `createEnvironmentRpcCommand` for an HTTP endpoint: the destination grant is checked when the
 * command runs, and `permissionAtom` drives the controls that start it.
 */
function createEnvironmentHttpCommand<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: ClientGuardedHttpTag;
    readonly execute: (input: Input, prepared: PreparedConnection) => Effect.Effect<A, E, R>;
  },
) {
  const permissions = createCommandPermissions(runtime, options.tag);
  const command = createEnvironmentCommand(runtime, {
    label: options.label,
    execute: (input: Input, registry, environmentId) =>
      permissions.authorize(registry, environmentId, input).pipe(
        Effect.andThen(preparedConnection(environmentId)),
        Effect.flatMap((prepared) => options.execute(input, prepared)),
      ),
  });
  return {
    ...command,
    requiredScopes: permissions.requiredScopes,
    permissionAtom: permissions.permissionAtom,
  };
}

type WithoutConnection<I> = Omit<I, "prepared">;

export function createScientSourcesCommands<R, ER>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient | R,
    ER
  >,
) {
  const command = <I extends { readonly prepared: PreparedConnection }, A, E>(
    tag: ClientGuardedHttpTag,
    request: (input: I) => Effect.Effect<A, E, HttpClient.HttpClient>,
  ) =>
    createEnvironmentHttpCommand(runtime, {
      label: `environment-command:${tag}`,
      tag,
      execute: (input: WithoutConnection<I>, prepared) =>
        // `I` is exactly its fields plus the connection, which `Omit` cannot prove back.
        request({ ...input, prepared } as unknown as I),
    });
  return {
    savePage: command(tags.savePage, http.saveEnvironmentScientSourcePage),
    updateMetadata: command(tags.updateMetadata, http.updateEnvironmentScientSourceMetadata),
    updateNote: command(tags.updateNote, http.updateEnvironmentScientSourceNote),
    refreshMetadata: command(tags.refreshMetadata, http.refreshEnvironmentScientSourceMetadata),
    remove: command(tags.remove, http.removeEnvironmentScientSource),
    organize: command(tags.organize, http.organizeEnvironmentScientSources),
    systematicReviewChange: command(
      tags.systematicReviewChange,
      http.changeEnvironmentScientSystematicReview,
    ),
    bulkUpdate: command(tags.bulkUpdate, http.bulkUpdateEnvironmentScientSources),
    addByIdentifier: command(tags.addByIdentifier, http.addEnvironmentScientSourcesByIdentifier),
    restore: command(tags.restore, http.restoreEnvironmentScientSource),
    deletePermanently: command(
      tags.deletePermanently,
      http.deleteEnvironmentScientSourcesPermanently,
    ),
    revert: command(tags.revert, http.revertEnvironmentScientSource),
    localPdfUpload: command(tags.localPdfUpload, http.uploadEnvironmentLocalSourcePdf),
    localBeginImport: command(tags.localBeginImport, http.beginEnvironmentLocalSourceImport),
    localDiscard: command(tags.localDiscard, http.discardEnvironmentLocalSourcePdfs),
    fileImport: command(tags.fileImport, http.importEnvironmentScientSourcesFile),
    beginImport: command(tags.beginImport, http.beginEnvironmentZoteroImport),
    beginScopedImport: command(tags.beginScopedImport, http.beginEnvironmentZoteroScopedImport),
    zoteroRefresh: command(tags.zoteroRefresh, http.refreshEnvironmentZoteroSources),
    zoteroSend: command(tags.zoteroSend, http.sendEnvironmentSourcesToZotero),
    advanceImport: command(tags.advanceImport, http.advanceEnvironmentScientSourcesImport),
    cancelImport: command(tags.cancelImport, http.cancelEnvironmentScientSourcesImport),
    retryImport: command(tags.retryImport, http.retryEnvironmentScientSourcesImport),
    syncBibliography: command(tags.syncBibliography, http.syncEnvironmentScientBibliography),
    citationStyleSet: command(tags.citationStyleSet, http.setEnvironmentScientCitationStyle),
    annotationsMutate: command(tags.annotationsMutate, mutateEnvironmentAnnotation),
    referencesResolve: command(tags.referencesResolve, resolveEnvironmentReferences),
  };
}

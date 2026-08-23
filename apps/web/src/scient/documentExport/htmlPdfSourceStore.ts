import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

import {
  sameTrackedHtmlSource,
  trackedHtmlLogicalDocumentKey,
  TrackedHtmlSourceSchema,
  type TrackedHtmlSource,
} from "./htmlPdfSource";

export type HtmlPdfUpdatePhase = "idle" | "updating" | "update-available" | "failed";

export interface HtmlPdfSourceRelation {
  readonly id: string;
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly source: TrackedHtmlSource;
  readonly logicalDocumentKey: string;
  readonly artifactId: string | null;
  readonly authorizedUrl: string | null;
  readonly updatePhase: HtmlPdfUpdatePhase;
  readonly updateMessage: string | null;
  readonly manualRequestId: number;
}

interface HtmlPdfSourceState {
  readonly relations: Readonly<Record<string, HtmlPdfSourceRelation>>;
  readonly bind: (input: {
    readonly threadRef: ScopedThreadRef;
    readonly tabId: string;
    readonly source: TrackedHtmlSource;
    readonly authorizedUrl: string;
  }) => void;
  readonly recordExport: (
    relationId: string,
    source: Extract<PdfSourceDescriptor, { readonly _tag: "generated-pdf" }>,
  ) => void;
  readonly setUpdateState: (
    relationId: string,
    phase: HtmlPdfUpdatePhase,
    message?: string | null,
  ) => void;
  readonly setAuthorizedUrl: (relationId: string, authorizedUrl: string) => void;
  readonly requestUpdate: (relationId: string) => void;
}

const MAX_PERSISTED_RELATIONS = 100;
const HtmlPdfUpdatePhaseSchema = Schema.Literals([
  "idle",
  "updating",
  "update-available",
  "failed",
]);
const PersistedHtmlPdfSourceRelation = Schema.Struct({
  id: Schema.String,
  threadRef: ScopedThreadRef,
  tabId: Schema.String,
  source: TrackedHtmlSourceSchema,
  logicalDocumentKey: Schema.String,
  artifactId: Schema.NullOr(Schema.String),
  authorizedUrl: Schema.NullOr(Schema.String),
  updatePhase: HtmlPdfUpdatePhaseSchema,
  updateMessage: Schema.NullOr(Schema.String),
  manualRequestId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const isPersistedHtmlPdfSourceRelation = Schema.is(PersistedHtmlPdfSourceRelation);

export function htmlPdfRelationId(threadRef: ScopedThreadRef, tabId: string): string {
  return JSON.stringify([scopedThreadKey(threadRef), tabId]);
}

function persistedRelations(
  relations: Readonly<Record<string, HtmlPdfSourceRelation>>,
): Readonly<Record<string, HtmlPdfSourceRelation>> {
  return Object.fromEntries(
    Object.entries(relations)
      .slice(-MAX_PERSISTED_RELATIONS)
      .map(([id, relation]) => [
        id,
        {
          ...relation,
          authorizedUrl: null,
          updatePhase:
            relation.updatePhase === "updating" ? "update-available" : relation.updatePhase,
          updateMessage:
            relation.updatePhase === "updating"
              ? "The source may have changed while Scient was closed."
              : relation.updateMessage,
          manualRequestId: 0,
        },
      ]),
  );
}

export function normalizePersistedHtmlPdfRelations(
  value: unknown,
): Readonly<Record<string, HtmlPdfSourceRelation>> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(-MAX_PERSISTED_RELATIONS)
      .flatMap(([id, candidate]) => {
        if (!isPersistedHtmlPdfSourceRelation(candidate)) return [];
        if (candidate.id !== id || htmlPdfRelationId(candidate.threadRef, candidate.tabId) !== id) {
          return [];
        }
        if (candidate.source.environmentId !== candidate.threadRef.environmentId) return [];
        const relation: HtmlPdfSourceRelation = {
          ...candidate,
          logicalDocumentKey: trackedHtmlLogicalDocumentKey(candidate.source),
          authorizedUrl: null,
          updatePhase:
            candidate.updatePhase === "updating" ? "update-available" : candidate.updatePhase,
          updateMessage:
            candidate.updatePhase === "updating"
              ? "The source may have changed while Scient was closed."
              : candidate.updateMessage,
          manualRequestId: 0,
        };
        return [[id, relation] as const];
      }),
  );
}

const STORAGE_KEY = "scient:html-pdf-sources:v1";

export const useHtmlPdfSourceStore = create<HtmlPdfSourceState>()(
  persist(
    (set) => ({
      relations: {},
      bind: (input) =>
        set((state) => {
          const id = htmlPdfRelationId(input.threadRef, input.tabId);
          const current = state.relations[id];
          const sameSource = current && sameTrackedHtmlSource(current.source, input.source);
          const relation: HtmlPdfSourceRelation = {
            id,
            threadRef: input.threadRef,
            tabId: input.tabId,
            source: input.source,
            logicalDocumentKey: trackedHtmlLogicalDocumentKey(input.source),
            artifactId: sameSource ? current.artifactId : null,
            authorizedUrl: input.authorizedUrl,
            updatePhase: sameSource ? current.updatePhase : "idle",
            updateMessage: sameSource ? current.updateMessage : null,
            manualRequestId: sameSource ? current.manualRequestId : 0,
          };
          const { [id]: _current, ...otherRelations } = state.relations;
          return {
            relations: Object.fromEntries(
              [...Object.entries(otherRelations), [id, relation]].slice(-MAX_PERSISTED_RELATIONS),
            ),
          };
        }),
      recordExport: (relationId, source) =>
        set((state) => {
          const current = state.relations[relationId];
          if (!current || current.logicalDocumentKey !== source.logicalDocumentKey) return state;
          return {
            relations: {
              ...state.relations,
              [relationId]: {
                ...current,
                artifactId: source.artifactId,
                updatePhase: "idle",
                updateMessage: null,
              },
            },
          };
        }),
      setUpdateState: (relationId, updatePhase, updateMessage = null) =>
        set((state) => {
          const current = state.relations[relationId];
          if (
            !current ||
            (current.updatePhase === updatePhase && current.updateMessage === updateMessage)
          ) {
            return state;
          }
          return {
            relations: {
              ...state.relations,
              [relationId]: { ...current, updatePhase, updateMessage },
            },
          };
        }),
      setAuthorizedUrl: (relationId, authorizedUrl) =>
        set((state) => {
          const current = state.relations[relationId];
          if (!current || current.authorizedUrl === authorizedUrl) return state;
          return {
            relations: {
              ...state.relations,
              [relationId]: { ...current, authorizedUrl },
            },
          };
        }),
      requestUpdate: (relationId) =>
        set((state) => {
          const relation = state.relations[relationId];
          if (!relation) return state;
          return {
            relations: {
              ...state.relations,
              [relationId]: {
                ...relation,
                manualRequestId: relation.manualRequestId + 1,
              },
            },
          };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ relations: persistedRelations(state.relations) }),
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== "object" || !("relations" in persisted)) {
          return current;
        }
        return {
          ...current,
          relations: normalizePersistedHtmlPdfRelations(persisted.relations),
        };
      },
    },
  ),
);

export function readHtmlPdfRelation(
  threadRef: ScopedThreadRef,
  tabId: string,
): HtmlPdfSourceRelation | null {
  return useHtmlPdfSourceStore.getState().relations[htmlPdfRelationId(threadRef, tabId)] ?? null;
}

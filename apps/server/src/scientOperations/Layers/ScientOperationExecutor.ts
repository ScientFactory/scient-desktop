/** Live host-neutral Scient operation executor. */
import { createHash, randomUUID } from "node:crypto";

import { Effect, Layer } from "effect";

import {
  beginScientOperation,
  completeScientOperation,
  ScientOperationInputError,
  type ScientOperationEffectIdentity,
} from "../authority.ts";
import {
  ScientOperationExecutor,
  type ScientOperationExecutionOutcome,
  type ScientOperationExecutorShape,
} from "../Services/ScientOperationExecutor.ts";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function payloadFingerprint(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function makeScientOperationExecutor(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly recordReceipt?: (receipt: ReturnType<typeof completeScientOperation>) => void;
}): ScientOperationExecutorShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;

  return {
    execute: (input) =>
      Effect.gen(function* () {
        const canonicalize = input.definition.canonicalizeInput;
        if (canonicalize === null) {
          return {
            kind: "input-rejected",
            error: new ScientOperationInputError(
              "This Scient operation does not yet have an executable domain-input contract.",
            ),
          } as const;
        }

        const canonical = yield* Effect.try({
          try: () => canonicalize(input.domainInput),
          catch: (error) => error,
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        );
        if (!canonical.ok) {
          return { kind: "input-rejected", error: canonical.error } as const;
        }

        const semanticIdempotencyIdentity =
          input.definition.idempotencyInputField === null
            ? null
            : typeof canonical.value[input.definition.idempotencyInputField] === "string"
              ? (canonical.value[input.definition.idempotencyInputField] as string)
              : null;
        const started = beginScientOperation({
          authority: input.authority,
          definition: input.definition,
          projectId: input.projectId,
          ingress: input.ingress,
          operationId: `scient-operation:${randomId()}`,
          semanticIdempotencyIdentity,
          payloadFingerprint: payloadFingerprint(canonical.value),
          receivedAt: now(),
        });
        if (!started.allow) {
          return { kind: "authority-rejected", decision: started.decision } as const;
        }

        const admission = yield* input.admit.pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        );
        if (!admission.ok) {
          return { kind: "admission-rejected", error: admission.error } as const;
        }

        const effects: ScientOperationEffectIdentity[] = [];
        const handler = Effect.suspend(() =>
          input.execute(canonical.value, {
            admission: admission.value,
            envelope: started.envelope,
            recordEffect: (effect) => effects.push({ ...effect }),
          }),
        );
        const execution = yield* (
          input.definition.effectClass === "transactional-write"
            ? input.runTransactionalWrite(handler)
            : Effect.raceFirst(handler, input.revocationFence)
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (result) => ({ ok: true as const, result }),
          }),
        );

        if (!execution.ok) {
          const errorCode =
            typeof execution.error === "object" &&
            execution.error !== null &&
            "code" in execution.error &&
            typeof execution.error.code === "string"
              ? execution.error.code
              : "operation_failed";
          const receipt = completeScientOperation({
            envelope: started.envelope,
            receiptId: `scient-receipt:${randomId()}`,
            finishedAt: now(),
            outcome:
              errorCode === "operation_outcome_uncertain" || effects.length > 0
                ? "uncertain/reconciliation-required"
                : "failed",
            errorCode,
            effects,
          });
          try {
            options?.recordReceipt?.(receipt);
          } catch {
            // F1 preserves the existing diagnostic-only receipt sink contract.
          }
          return {
            kind: "finished",
            result: null,
            error: execution.error,
            receipt,
          } satisfies ScientOperationExecutionOutcome<never, typeof execution.error>;
        }

        if (input.definition.effectClass === "read") {
          const released = yield* input.releaseRead(admission.value).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: () => ({ ok: true as const }),
            }),
          );
          if (!released.ok) {
            const errorCode =
              typeof released.error === "object" &&
              released.error !== null &&
              "code" in released.error &&
              typeof released.error.code === "string"
                ? released.error.code
                : "operation_failed";
            const receipt = completeScientOperation({
              envelope: started.envelope,
              receiptId: `scient-receipt:${randomId()}`,
              finishedAt: now(),
              outcome: "failed",
              errorCode,
              effects,
            });
            try {
              options?.recordReceipt?.(receipt);
            } catch {
              // See the execution-failure path above.
            }
            return {
              kind: "finished",
              result: null,
              error: released.error,
              receipt,
            } satisfies ScientOperationExecutionOutcome<never, typeof released.error>;
          }
        }

        const resultErrorCode = input.resultErrorCode(execution.result);
        const receipt = completeScientOperation({
          envelope: started.envelope,
          receiptId: `scient-receipt:${randomId()}`,
          finishedAt: now(),
          outcome:
            resultErrorCode === "operation_outcome_uncertain" ||
            (resultErrorCode !== null && effects.length > 0)
              ? "uncertain/reconciliation-required"
              : resultErrorCode === null
                ? "succeeded"
                : "failed",
          errorCode: resultErrorCode,
          effects,
        });
        try {
          options?.recordReceipt?.(receipt);
        } catch {
          // Receipt observers cannot alter the governed operation result in F1.
        }
        return { kind: "finished", result: execution.result, error: null, receipt } as const;
      }),
  };
}

export const ScientOperationExecutorLive = Layer.sync(
  ScientOperationExecutor,
  makeScientOperationExecutor,
);

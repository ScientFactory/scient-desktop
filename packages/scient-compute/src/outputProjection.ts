import type { ComputeOutput } from "./contract.ts";
import type {
  ComputeDisplayId,
  ComputeDisplayOutput,
  ComputeRepresentationBundle,
} from "./representation.ts";

type ComputeNonDisplayOutput = Exclude<ComputeOutput, ComputeDisplayOutput>;

/** One currently visible rich result derived from immutable display facts. */
export interface ComputeProjectedRepresentation {
  readonly _tag: "representation";
  readonly kind: "display-data" | "execute-result";
  readonly sequence: number;
  readonly observedAt: string;
  readonly revisionSequence: number;
  readonly revisedAt: string;
  readonly bundle: ComputeRepresentationBundle;
  readonly displayId: ComputeDisplayId | null;
  readonly executionCount: number | null;
}

export type ComputeProjectedOutput = ComputeNonDisplayOutput | ComputeProjectedRepresentation;

/** One retained fact attributed to the output area it originally belonged to. */
export interface ComputeOutputAreaFact<AreaId> {
  readonly areaId: AreaId;
  readonly output: ComputeOutput;
}

function isRuntimePresentation(output: ComputeProjectedOutput): boolean {
  return output._tag !== "system";
}

function clearRuntimePresentation(
  outputs: ReadonlyArray<ComputeProjectedOutput>,
): ReadonlyArray<ComputeProjectedOutput> {
  return outputs.filter((output) => !isRuntimePresentation(output));
}

function isOutputProducingFact(output: ComputeOutput): boolean {
  return output._tag !== "system" && output._tag !== "clear-output";
}

/**
 * Derives current output areas from an append-only transcript.
 *
 * Facts must be supplied in durable append order and belong to one runtime
 * session generation. That is the scope in which a Jupyter display ID has
 * meaning; a restart cannot update a display created by the namespace it
 * destroyed.
 *
 * Display updates preserve the original display position and identity while
 * replacing its representation bundle. `clear_output(wait=true)` clears only
 * when the next output-producing fact arrives. Scient system facts survive a
 * runtime clear because they describe retained-history integrity, not cell
 * presentation.
 */
export function projectComputeOutputAreas<AreaId>(
  facts: ReadonlyArray<ComputeOutputAreaFact<AreaId>>,
): ReadonlyMap<AreaId, ReadonlyArray<ComputeProjectedOutput>> {
  const areas = new Map<AreaId, ComputeProjectedOutput[]>();
  const clearOnNextOutput = new Set<AreaId>();
  const createdAtFact = new Map<ComputeProjectedRepresentation, number>();
  const latestDisplayUpdates = new Map<
    ComputeDisplayId,
    {
      readonly factIndex: number;
      readonly sequence: number;
      readonly observedAt: string;
      readonly bundle: ComputeRepresentationBundle;
    }
  >();

  for (let factIndex = 0; factIndex < facts.length; factIndex += 1) {
    const fact = facts[factIndex];
    if (fact === undefined) continue;
    const { areaId, output } = fact;
    const outputs = areas.get(areaId) ?? [];
    if (!areas.has(areaId)) areas.set(areaId, outputs);

    if (output._tag === "clear-output") {
      if (output.wait) clearOnNextOutput.add(areaId);
      else {
        areas.set(areaId, [...clearRuntimePresentation(outputs)]);
        clearOnNextOutput.delete(areaId);
      }
      continue;
    }

    let current = outputs;
    if (clearOnNextOutput.has(areaId) && isOutputProducingFact(output)) {
      current = [...clearRuntimePresentation(current)];
      areas.set(areaId, current);
      clearOnNextOutput.delete(areaId);
    }

    if (output._tag === "display-update") {
      latestDisplayUpdates.set(output.displayId, {
        factIndex,
        sequence: output.sequence,
        observedAt: output.observedAt,
        bundle: output.bundle,
      });
      continue;
    }

    if (output._tag === "display-data") {
      const projected: ComputeProjectedRepresentation = {
        _tag: "representation",
        kind: "display-data",
        sequence: output.sequence,
        observedAt: output.observedAt,
        revisionSequence: output.sequence,
        revisedAt: output.observedAt,
        bundle: output.bundle,
        displayId: output.displayId,
        executionCount: null,
      };
      current.push(projected);
      createdAtFact.set(projected, factIndex);
      areas.set(areaId, current);
      continue;
    }

    if (output._tag === "execute-result") {
      current.push({
        _tag: "representation",
        kind: "execute-result",
        sequence: output.sequence,
        observedAt: output.observedAt,
        revisionSequence: output.sequence,
        revisedAt: output.observedAt,
        bundle: output.bundle,
        displayId: null,
        executionCount: output.executionCount,
      });
      areas.set(areaId, current);
      continue;
    }

    current.push(output);
    areas.set(areaId, current);
  }

  return new Map(
    [...areas].map(([areaId, outputs]) => [
      areaId,
      outputs.map((output) => {
        if (output._tag !== "representation" || output.displayId === null) return output;
        const update = latestDisplayUpdates.get(output.displayId);
        const createdAt = createdAtFact.get(output);
        if (update === undefined || createdAt === undefined || update.factIndex <= createdAt) {
          return output;
        }
        return {
          ...output,
          bundle: update.bundle,
          revisionSequence: update.sequence,
          revisedAt: update.observedAt,
        };
      }),
    ]),
  );
}

/** Convenience projection for one execution or notebook cell output area. */
export function projectComputeOutputs(
  transcript: ReadonlyArray<ComputeOutput>,
): ReadonlyArray<ComputeProjectedOutput> {
  const areaId = Symbol("compute-output-area");
  return (
    projectComputeOutputAreas(transcript.map((output) => ({ areaId, output }))).get(areaId) ?? []
  );
}

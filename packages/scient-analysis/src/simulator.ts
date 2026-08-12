import type {
  AnalysisRuntimeAdapter,
  AnalysisRuntimeProfile,
  AnalysisRunContext,
} from "./contract.ts";

/** Runtime adapter double that exercises the same coordinator port as MATLAB and future languages. */
export function createSimulatedAnalysisAdapter(options: {
  readonly profile: AnalysisRuntimeProfile;
  readonly command?: ReadonlyArray<string>;
}): AnalysisRuntimeAdapter {
  return {
    id: options.profile.id,
    kind: options.profile.kind,
    fileExtensions: [".sim"],
    inspect: async () => options.profile,
    prepare: (context: AnalysisRunContext) => ({
      executable: options.command?.[0] ?? "scient-analysis-simulator",
      args: options.command?.slice(1) ?? [context.source.relativePath],
      cwd: context.source.cwd,
      environment: {},
    }),
  };
}

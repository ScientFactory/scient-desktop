import { T3_PROJECT_FILE_NAME } from "./t3ProjectFile.ts";

/** Scient's name for the checked-in project file. */
export const SCIENT_PROJECT_FILE_NAME = "scient.json";

/**
 * The project file names Scient reads, in order. The first that exists is the project's file, so a
 * `scient.json` wins and a repository set up with `t3.json` keeps working.
 */
export const PROJECT_FILE_NAMES = [SCIENT_PROJECT_FILE_NAME, T3_PROJECT_FILE_NAME] as const;

export type ProjectFileName = (typeof PROJECT_FILE_NAMES)[number];

export const isProjectFileName = (relativePath: string): relativePath is ProjectFileName =>
  (PROJECT_FILE_NAMES as ReadonlyArray<string>).includes(relativePath);

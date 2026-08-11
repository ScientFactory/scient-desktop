import { shouldCreateNewThreadInCurrentProject } from "../Sidebar.logic";

export function shouldCreateScientThreadInCurrentProject(input: {
  shiftKey: boolean;
  projectGroupCount: number;
  supportsProjectlessThreads: boolean;
}): boolean {
  if (!input.supportsProjectlessThreads) {
    return shouldCreateNewThreadInCurrentProject(input.shiftKey, input.projectGroupCount);
  }

  // Projectless support adds another target even when only one project is
  // configured. Direct creation therefore requires Shift and a real project.
  return input.shiftKey && input.projectGroupCount > 0;
}

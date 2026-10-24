// SCIENT-OWNED: Add project ▸ Overleaf project. The Add project list carries
// the entry; the Connect to Overleaf dialog, in its new-project mode, makes the
// Scient project and brings the paper in as a subfolder of it.
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef } from "react";
import { create } from "zustand";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { waitForProjectProjection } from "~/lib/projectProjection";
import { readLocalApi } from "~/localApi";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";

import { ConnectOverleafDialog } from "./ConnectOverleafDialog";
import { createProjectForOverleaf, type ProjectForOverleaf } from "./createProjectForOverleaf";

interface OverleafNewProjectRequest {
  readonly environmentId: EnvironmentId;
  /** Where Add project starts browsing for this environment. */
  readonly location: string;
  /** The system's folder chooser opens folders on this computer only. */
  readonly canChooseFolder: boolean;
}

const useRequest = create<{ request: OverleafNewProjectRequest | null }>(() => ({
  request: null,
}));

/** The Add project list's "Overleaf project" entry for one environment. */
export function overleafAddProjectItem(input: {
  readonly environmentId: EnvironmentId;
  readonly location: string;
  /** Whether the environment runs on this computer. */
  readonly isPrimary: boolean;
}): CommandPaletteActionItem {
  const request: OverleafNewProjectRequest = {
    environmentId: input.environmentId,
    location: input.location,
    canChooseFolder: input.isPrimary && typeof window !== "undefined" && !!window.desktopBridge,
  };
  return {
    kind: "action",
    value: `action:add-project:${input.environmentId}:overleaf`,
    searchTerms: ["overleaf", "latex", "paper", "thesis", "tex"],
    title: "Overleaf project",
    description: "Bring a paper in from Overleaf",
    icon: <OverleafMark aria-hidden className={ITEM_ICON_CLASS} />,
    // The palette closes; the dialog takes over.
    run: async () => {
      useRequest.setState({ request });
    },
  };
}

/**
 * Places the Overleaf project choice in the Add project sources: right after
 * GitHub, or after Git URL when GitHub is not listed, else last.
 */
export function insertOverleafAddProjectItem(
  sources: Array<{ readonly value: string }>,
  input: Parameters<typeof overleafAddProjectItem>[0],
): void {
  const prefix = `action:add-project:${input.environmentId}:`;
  const after = (source: string) =>
    sources.findIndex(
      (item) =>
        item.value === `${prefix}${source}` || item.value === `${prefix}${source}:not-ready`,
    );
  const anchor = after("github") >= 0 ? after("github") : after("url");
  const item = overleafAddProjectItem(input);
  if (anchor >= 0) sources.splice(anchor + 1, 0, item);
  else sources.push(item);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path);
}

async function chooseFolder(current: string): Promise<string | null> {
  const api = readLocalApi();
  if (!api) return null;
  const initialPath = current.trim();
  return api.dialogs
    .pickFolder(isAbsolutePath(initialPath) ? { initialPath } : undefined)
    .catch(() => null);
}

/** Mounted once at the app's root, so the dialog outlives the palette. */
export function OverleafNewProjectDialogHost() {
  const request = useRequest((state) => state.request);
  return request ? (
    <OverleafNewProjectDialog
      key={`${request.environmentId}\u0000${request.location}`}
      request={request}
    />
  ) : null;
}

function OverleafNewProjectDialog({ request }: { readonly request: OverleafNewProjectRequest }) {
  const openNewThread = useNewThreadHandler();
  const made = useRef<ProjectForOverleaf | null>(null);

  // Closing lands in the project, linked or not: a made project is never undone.
  const close = () => {
    useRequest.setState({ request: null });
    const project = made.current;
    if (project === null) return;
    void openMadeProject(project).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };

  const openMadeProject = async (project: ProjectForOverleaf) => {
    // The project may have reached the sidebar since it was made; wait for it again.
    const ready = project.ready || (await waitForProjectProjection(project.projectRef));
    if (!ready) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "The project is made but not in the sidebar yet",
          description: `It's in ${project.cwd}. It appears in the sidebar once this window catches up; Add project ▸ Local folder opens it too.`,
        }),
      );
      return;
    }
    await openNewThread(project.projectRef);
  };

  return (
    <ConnectOverleafDialog
      environmentId={request.environmentId}
      cwd=""
      folder=""
      newProject={{
        location: request.location,
        chooseFolder: request.canChooseFolder ? chooseFolder : undefined,
        create: async (root) => {
          const project = await createProjectForOverleaf({
            environmentId: request.environmentId,
            root,
          });
          made.current = project;
          return project.cwd;
        },
      }}
      onClose={close}
    />
  );
}

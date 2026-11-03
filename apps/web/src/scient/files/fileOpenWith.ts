// SCIENT-OWNED: the Files menu's Open With lists every app the computer offers
// for an entry (as Finder does), beside the code editors Scient already knows.
import type { ContextMenuItem, WorkspaceOpenWithApps } from "@t3tools/contracts";

const OPEN_APP_PREFIX = "files:open-app:";
const OPEN_APP_CHOOSER = "files:open-app-chooser";

/** Apps per kind of entry (extension, or folder) for this session; they rarely change. */
const appsByKind = new Map<string, WorkspaceOpenWithApps>();

export function openWithKind(environmentId: string, relativePath: string, isFolder: boolean) {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const kind = isFolder ? "/" : dot > 0 ? name.slice(dot).toLowerCase() : name;
  return `${environmentId}\u0000${kind}`;
}

export async function cachedOpenWithApps(
  kind: string,
  load: () => Promise<WorkspaceOpenWithApps | null>,
): Promise<WorkspaceOpenWithApps | null> {
  const cached = appsByKind.get(kind);
  if (cached) return cached;
  const loaded = await load();
  if (loaded) appsByKind.set(kind, loaded);
  return loaded;
}

/**
 * The menu with Open With holding the computer's apps (its default first),
 * then the code editors, then the computer's own chooser where it has one.
 * An app that is also a listed editor appears once, as the editor.
 */
export function withOpenWithApps(
  items: ReadonlyArray<ContextMenuItem>,
  offered: WorkspaceOpenWithApps | null,
): ContextMenuItem[] {
  const existing = items.find((item) => item.id === "open-with");
  const editors = existing?.children ?? [];
  const editorNames = new Set(editors.map((editor) => editor.label));
  const apps = (offered?.apps ?? []).filter((app) => !editorNames.has(app.name));
  const children: ContextMenuItem[] = [
    ...apps.map((app, index) => ({
      id: `${OPEN_APP_PREFIX}${index}`,
      label: app.isDefault ? `${app.name} (default)` : app.name,
    })),
    ...editors.map((editor, index) =>
      index === 0 && apps.length > 0 ? { ...editor, separatorBefore: true } : editor,
    ),
    ...(offered?.chooser
      ? [
          {
            id: OPEN_APP_CHOOSER,
            label: "Other App…",
            separatorBefore: apps.length + editors.length > 0,
          },
        ]
      : []),
  ];
  if (children.length === 0) return [...items];
  const openWith: ContextMenuItem = { id: "open-with", label: "Open with", children };
  if (existing) return items.map((item) => (item === existing ? openWith : item));
  // Without code editors there was no Open With: it goes after Open and Reveal.
  const after = items.findLastIndex((item) => item.id === "open" || item.id === "reveal-in-folder");
  return [...items.slice(0, after + 1), openWith, ...items.slice(after + 1)];
}

/** The app a menu id names, from the list the menu was built with. */
export function openWithChoice(
  clicked: string,
  offered: WorkspaceOpenWithApps | null,
  editorNames: ReadonlySet<string>,
): { readonly _tag: "app"; readonly id: string } | { readonly _tag: "chooser" } | null {
  if (clicked === OPEN_APP_CHOOSER) return { _tag: "chooser" };
  if (!clicked.startsWith(OPEN_APP_PREFIX)) return null;
  const apps = (offered?.apps ?? []).filter((app) => !editorNames.has(app.name));
  const app = apps[Number(clicked.slice(OPEN_APP_PREFIX.length))];
  return app ? { _tag: "app", id: app.id } : null;
}

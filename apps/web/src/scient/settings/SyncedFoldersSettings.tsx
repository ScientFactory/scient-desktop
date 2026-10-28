// SCIENT-OWNED: Settings ▸ Synced folders. The services a project folder keeps in
// sync with, for the one computer the settings scope picks: Overleaf, and the
// services the Files bar's Connect menu lists as on the way.
import { SettingsPageContainer, SettingsSection } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { Badge } from "~/components/ui/badge";
import { CONNECT_SERVICES } from "~/scient/files/FileBrowserToolbarActions";
import { OverleafSyncedFolderRow, SyncedFolderMark } from "~/scient/overleaf/OverleafSettings";

export function SyncedFoldersSettings() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  return (
    <SettingsPageContainer>
      <SettingsSection id={searchableSetting("synced-folders").id} title="Synced folders" hideTitle>
        {environmentId === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to manage its synced folders.
          </p>
        ) : (
          <>
            {/* The token and links belong to one computer; switching must not carry a draft over. */}
            <OverleafSyncedFolderRow key={environmentId} environmentId={environmentId} />
            {CONNECT_SERVICES.filter((service) => service.id !== "overleaf").map(
              ({ id, label, Mark }) => (
                <div
                  key={id}
                  className="flex items-center gap-2 px-3 py-3 first:rounded-t-xl last:rounded-b-xl sm:px-4"
                >
                  <SyncedFolderMark Mark={Mark} dot="bg-muted-foreground/35" />
                  <span className="truncate text-sm font-medium text-foreground">{label}</span>
                  <Badge variant="outline" size="sm">
                    Coming soon
                  </Badge>
                </div>
              ),
            )}
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

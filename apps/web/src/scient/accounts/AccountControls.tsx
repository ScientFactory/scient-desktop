import { useState } from "react";
import type { AccountAccess, AccountTarget, GrantScope, EnvironmentId } from "@t3tools/contracts";
import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "~/components/ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { Checkbox } from "~/components/ui/checkbox";
import { NativeSelect } from "~/components/ui/select";
import { useProjects } from "~/state/entities";
import { accountsState } from "./accountsState";
import { useAccountCommand } from "./useAccounts";

export function AccessChip({
  environmentId,
  target,
  access,
  disabled,
}: {
  environmentId: EnvironmentId;
  target: AccountTarget;
  access: AccountAccess;
  disabled: boolean;
}) {
  const update = useAccountCommand(accountsState.setControls, environmentId);
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" disabled={disabled} />}>
        {access === "allowed" ? "Allowed" : access === "ask" ? "Ask me" : "Off"}
      </MenuTrigger>
      <MenuPopup>
        {(
          [
            ["allowed", "Allowed"],
            ["ask", "Ask me"],
            ["off", "Off"],
          ] as const
        ).map(([value, label]) => (
          <MenuItem key={value} onClick={() => void update({ target, access: value })}>
            {label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

export function ScopeDialog({
  environmentId,
  scope,
  onSave,
  onClose,
}: {
  environmentId: EnvironmentId;
  scope: GrantScope;
  onSave: (scope: GrantScope) => Promise<void>;
  onClose: () => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const [draft, setDraft] = useState(scope);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Available in</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <NativeSelect
              aria-label="Project scope"
              value={draft.type}
              onChange={(event) =>
                setDraft(
                  event.target.value === "all-projects"
                    ? { type: "all-projects" }
                    : { type: "projects", projectIds: [] },
                )
              }
            >
              <option value="all-projects">All projects</option>
              <option value="projects">Selected projects</option>
            </NativeSelect>
            {draft.type === "projects"
              ? projects.map((project) => (
                  <label key={project.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.projectIds.includes(project.id)}
                      onCheckedChange={(checked) =>
                        setDraft({
                          type: "projects",
                          projectIds: checked
                            ? [...draft.projectIds, project.id]
                            : draft.projectIds.filter((id) => id !== project.id),
                        })
                      }
                    />
                    {project.title}
                  </label>
                ))
              : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSave(draft);
              setBusy(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ControlsMenu({
  disabled,
  children,
}: {
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost" size="icon-xs" aria-label="Account menu" disabled={disabled} />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup>{children}</MenuPopup>
    </Menu>
  );
}

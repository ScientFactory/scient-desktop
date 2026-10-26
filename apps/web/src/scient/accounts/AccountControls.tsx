import type { AccountAccess, AccountTarget, GrantScope, EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, MoreHorizontalIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "~/components/ui/menu";
import { useProjects } from "~/state/entities";
import { accountsState } from "./accountsState";
import { toggleScope } from "./accountsView";
import { useAccountCommand } from "./useAccounts";

const ACCESS_LABELS: Readonly<Record<AccountAccess, string>> = {
  allowed: "Allowed",
  ask: "Ask me",
  off: "Off",
};

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
        {ACCESS_LABELS[access]}
        <ChevronDownIcon aria-hidden className="-me-1 size-3 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={access}
          onValueChange={(next) => {
            if (next === "allowed" || next === "ask" || next === "off")
              void update({ target, access: next });
          }}
        >
          {(["allowed", "ask", "off"] as const).map((value) => (
            <MenuRadioItem key={value} value={value} closeOnClick>
              <span className="flex min-w-0 items-center justify-between gap-3">
                {ACCESS_LABELS[value]}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** "Available in" as a submenu of the row's menu; every tick applies at once. */
export function ScopeSubmenu({
  environmentId,
  target,
  scope,
}: {
  environmentId: EnvironmentId;
  target: AccountTarget;
  scope: GrantScope;
}) {
  const update = useAccountCommand(accountsState.setControls, environmentId);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const projectIds = projects.map((project) => project.id);
  const apply = (next: GrantScope) => void update({ target, scope: next });
  return (
    <MenuSub>
      <MenuSubTrigger>Available in</MenuSubTrigger>
      <MenuSubPopup>
        <MenuCheckboxItem
          checked={scope.type === "all-projects"}
          onCheckedChange={(checked) =>
            apply(toggleScope(scope, projectIds, { type: "all" }, checked))
          }
        >
          All projects
        </MenuCheckboxItem>
        {projects.length ? <MenuSeparator /> : null}
        {projects.map((project) => (
          <MenuCheckboxItem
            key={project.id}
            checked={scope.type === "all-projects" || scope.projectIds.includes(project.id)}
            onCheckedChange={(checked) =>
              apply(
                toggleScope(scope, projectIds, { type: "project", projectId: project.id }, checked),
              )
            }
          >
            {project.title}
          </MenuCheckboxItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
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

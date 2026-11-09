import type {
  EnvironmentId,
  ScientSkillCatalogItem,
  ScientSkillInventoryDiagnostic,
  ScientSkillInvocationPolicy,
  ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { useEnvironmentQuery } from "../../state/query";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "../extensions/ExtensionsFeedback";
import { ManagedSkillCard } from "./ManagedSkillCard";
import {
  exportPersonalSkill,
  removePersonalSkill,
  scientSkillsInventory,
  setScientSkillUserActivation,
  undoPersonalSkill,
} from "./scientSkillsState";
import { SkillSettingsRow } from "./SkillSettingsRow";
import {
  fixSkillPrompt,
  improveSkillPrompt,
  type SkillChatPurpose,
  useSkillAgentChat,
} from "./skillAgentChat";

const PERSONAL_PROBLEMS = new Set([
  "personal-skill-invalid",
  "personal-skill-collision",
  "personal-skill-limit",
]);

const folderName = (path: string) => path.split(/[\\/]/u).pop() ?? path;

/** "From notes.zip · Changed by an agent" */
function statusOf(skill: ScientSkillCatalogItem): string {
  const parts = [skill.personal?.source ? `From ${skill.personal.source}` : "Your skill"];
  if (skill.personal?.changedBy === "agent") parts.push("Changed by an agent");
  return parts.join(" · ");
}

function downloadZip(fileName: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Skills the user added or an agent saved for them: on or off, Undo for the last change, and a
 * menu to show the folder, export, improve with an agent or remove. Broken folders are listed
 * with what is wrong and an agent to fix them.
 */
export function PersonalSkillsSection({
  environmentId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const inventory = useEnvironmentQuery(scientSkillsInventory({ environmentId, input: {} }));
  const setActivation = useAtomCommand(setScientSkillUserActivation, { reportFailure: true });
  const remove = useAtomCommand(removePersonalSkill, { reportFailure: false });
  const undo = useAtomCommand(undoPersonalSkill, { reportFailure: false });
  const exportSkill = useAtomCommand(exportPersonalSkill, { reportFailure: false });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  // Removing, undoing and exporting need the settings grant; the server checks it too.
  const canWrite = useAtomValue(removePersonalSkill.permissionAtom(environmentId));
  const startChat = useSkillAgentChat(environmentId);
  const [pending, setPending] = useState<string | null>(null);
  const [opened, setOpened] = useState<ScientSkillCatalogItem | null>(null);

  const skills = (inventory.data?.skills ?? []).filter((skill) => skill.origin === "personal");
  const problems = (inventory.data?.diagnostics ?? []).filter((diagnostic) =>
    PERSONAL_PROBLEMS.has(diagnostic.code),
  );

  const run = async <T,>(
    key: string,
    action: () => Promise<{ readonly _tag: string } & T>,
    failureTitle: string,
  ) => {
    setPending(key);
    const result = await action();
    setPending(null);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: commandFailureMessage(result as never) ?? undefined,
      });
      return false;
    }
    return true;
  };

  const showFolder = (folder: string) =>
    void openInEditor({
      environmentId,
      input: { cwd: folder, editor: "file-manager", reveal: true },
    }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Unable to show the folder",
          description: folder,
        });
      }
    });

  const undoChange = (name: string) =>
    void run(name, () => undo({ environmentId, input: { name } }), `Could not undo ${name}`);

  const removeSkill = async (name: string) => {
    if (
      !(await run(
        name,
        () => remove({ environmentId, input: { name } }),
        `Could not remove ${name}`,
      ))
    )
      return;
    toastManager.add({
      type: "success",
      title: `Removed ${name}`,
      actionProps: { children: "Undo", onClick: () => undoChange(name) },
    });
  };

  const exportZip = async (name: string) => {
    setPending(name);
    const result = await exportSkill({ environmentId, input: { name } });
    setPending(null);
    if (result._tag === "Success") downloadZip(result.value.fileName, result.value.base64);
    else
      toastManager.add({
        type: "error",
        title: `Could not export ${name}`,
        description: commandFailureMessage(result) ?? undefined,
      });
  };

  const ask = (prompt: string, purpose: SkillChatPurpose) => {
    if (!startChat) return;
    void startChat(prompt, purpose).then((opened) => {
      if (!opened) toastManager.add({ type: "error", title: "Could not open a new chat" });
    });
  };

  const update = (
    skill: ScientSkillCatalogItem,
    patch: { readonly active?: boolean; readonly invocationPolicy?: ScientSkillInvocationPolicy },
  ) =>
    void run(
      skill.name,
      () =>
        setActivation({
          environmentId,
          input: {
            releaseKey: skill.releaseKey,
            active: patch.active ?? skill.active,
            invocationPolicy: patch.invocationPolicy ?? skill.invocationPolicy,
          },
        }),
      `Could not change ${skill.name}`,
    );

  if (inventory.data === null && !inventory.error) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (skills.length === 0 && problems.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        None yet. Choose Add your own to add a skill from a file, a web address or your other
        agents, or ask any agent to make one for you.
      </p>
    );
  }
  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>:not(:first-child)]:border-t [&>:not(:first-child)]:border-border/60">
        {skills.map((skill) => {
          const folder = skill.personal?.folder;
          return (
            <SkillSettingsRow
              key={skill.releaseKey}
              skill={skill}
              pending={pending === skill.name}
              disabled={pending !== null}
              status={statusOf(skill)}
              onOpen={() => setOpened(skill)}
              onUpdate={(patch) => update(skill, patch)}
              actions={
                <>
                  {skill.personal?.changedBy === "agent" && skill.personal.canUndo ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={pending !== null || !canWrite}
                      onClick={() => undoChange(skill.name)}
                    >
                      Undo
                    </Button>
                  ) : null}
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost-muted"
                          aria-label={`More for ${skill.name}`}
                        />
                      }
                    >
                      <EllipsisIcon aria-hidden />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {startChat ? (
                        <MenuItem onClick={() => ask(improveSkillPrompt(skill.name), "improve")}>
                          Improve with an agent
                        </MenuItem>
                      ) : null}
                      {folder ? (
                        <MenuItem onClick={() => showFolder(folder)}>Show in folder</MenuItem>
                      ) : null}
                      <MenuItem disabled={!canWrite} onClick={() => void exportZip(skill.name)}>
                        Export as .zip
                      </MenuItem>
                      {skill.personal?.canUndo ? (
                        <MenuItem disabled={!canWrite} onClick={() => undoChange(skill.name)}>
                          Undo last change
                        </MenuItem>
                      ) : null}
                      <MenuSeparator />
                      <MenuItem disabled={!canWrite} onClick={() => void removeSkill(skill.name)}>
                        Remove
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </>
              }
            />
          );
        })}
        {problems.map((problem) => (
          <ProblemRow
            key={`${problem.code}:${problem.path ?? ""}`}
            problem={problem}
            pending={pending !== null || !canWrite}
            onShow={problem.path ? () => showFolder(problem.path!) : undefined}
            onFix={
              startChat && problem.path
                ? () =>
                    ask(
                      fixSkillPrompt(folderName(problem.path!), problem.message, problem.path!),
                      "fix",
                    )
                : undefined
            }
            onRemove={problem.path ? () => void removeSkill(folderName(problem.path!)) : undefined}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Changes apply to the next message.</p>
      {opened ? (
        <ManagedSkillCard
          key={opened.releaseKey}
          environmentId={environmentId}
          skill={skills.find((skill) => skill.name === opened.name) ?? opened}
          provider={providers.find(
            (provider) =>
              provider.enabled &&
              provider.installed &&
              inventory.data?.supportedProviders.includes(provider.driver),
          )}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  );
}

function ProblemRow({
  problem,
  pending,
  onShow,
  onFix,
  onRemove,
}: {
  readonly problem: ScientSkillInventoryDiagnostic;
  readonly pending: boolean;
  readonly onShow: (() => void) | undefined;
  readonly onFix: (() => void) | undefined;
  readonly onRemove: (() => void) | undefined;
}) {
  const name = problem.path ? folderName(problem.path) : "A skill";
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="grid min-w-0 gap-0.5">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="text-xs text-destructive-foreground [overflow-wrap:anywhere]">
          Does not load: {problem.message}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1">
        {onFix ? (
          <Button size="xs" variant="outline" disabled={pending} onClick={onFix}>
            Fix with an agent
          </Button>
        ) : null}
        <Menu>
          <MenuTrigger
            render={<Button size="icon-sm" variant="ghost-muted" aria-label={`More for ${name}`} />}
          >
            <EllipsisIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            {onShow ? <MenuItem onClick={onShow}>Show in folder</MenuItem> : null}
            {onRemove ? (
              <MenuItem disabled={pending} onClick={onRemove}>
                Remove
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}

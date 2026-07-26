import type { ProjectId } from "@synara/contracts";

export interface ProjectRemovalReservation {
  readonly projectId: ProjectId;
  readonly token: symbol;
}

export interface ProjectSendLease {
  readonly projectId: ProjectId;
  readonly token: symbol;
}

const removalTokenByProjectId = new Map<ProjectId, symbol>();
const activeSendTokensByProjectId = new Map<ProjectId, Set<symbol>>();
const drainWaitersByProjectId = new Map<ProjectId, Set<() => void>>();

function resolveProjectDrainWaiters(projectId: ProjectId): void {
  const waiters = drainWaitersByProjectId.get(projectId);
  if (!waiters) return;
  drainWaitersByProjectId.delete(projectId);
  for (const resolve of waiters) resolve();
}

export function reserveProjectRemoval(projectId: ProjectId): ProjectRemovalReservation | null {
  if (removalTokenByProjectId.has(projectId)) return null;
  const token = Symbol(`project-removal:${projectId}`);
  removalTokenByProjectId.set(projectId, token);
  return { projectId, token };
}

export function isProjectRemovalReserved(projectId: ProjectId): boolean {
  return removalTokenByProjectId.has(projectId);
}

export function hasActiveProjectSends(projectId: ProjectId): boolean {
  return (activeSendTokensByProjectId.get(projectId)?.size ?? 0) > 0;
}

export function releaseProjectRemoval(reservation: ProjectRemovalReservation): void {
  if (removalTokenByProjectId.get(reservation.projectId) !== reservation.token) return;
  removalTokenByProjectId.delete(reservation.projectId);
  resolveProjectDrainWaiters(reservation.projectId);
}

export function tryBeginProjectSend(projectId: ProjectId): ProjectSendLease | null {
  if (removalTokenByProjectId.has(projectId)) return null;
  const token = Symbol(`project-send:${projectId}`);
  const activeTokens = activeSendTokensByProjectId.get(projectId) ?? new Set<symbol>();
  activeTokens.add(token);
  activeSendTokensByProjectId.set(projectId, activeTokens);
  return { projectId, token };
}

export function finishProjectSend(lease: ProjectSendLease): void {
  const activeTokens = activeSendTokensByProjectId.get(lease.projectId);
  if (!activeTokens?.delete(lease.token)) return;
  if (activeTokens.size > 0) return;
  activeSendTokensByProjectId.delete(lease.projectId);
  resolveProjectDrainWaiters(lease.projectId);
}

export async function waitForProjectSendsToDrain(
  reservation: ProjectRemovalReservation,
): Promise<boolean> {
  if (removalTokenByProjectId.get(reservation.projectId) !== reservation.token) return false;
  if ((activeSendTokensByProjectId.get(reservation.projectId)?.size ?? 0) === 0) return true;
  await new Promise<void>((resolve) => {
    const waiters = drainWaitersByProjectId.get(reservation.projectId) ?? new Set<() => void>();
    waiters.add(resolve);
    drainWaitersByProjectId.set(reservation.projectId, waiters);
  });
  return removalTokenByProjectId.get(reservation.projectId) === reservation.token;
}

export function resetProjectRemovalCoordinationForTests(): void {
  removalTokenByProjectId.clear();
  activeSendTokensByProjectId.clear();
  for (const projectId of drainWaitersByProjectId.keys()) {
    resolveProjectDrainWaiters(projectId);
  }
}

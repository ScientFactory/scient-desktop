import type { ProjectId } from "@synara/contracts";

export interface ProjectRemovalReservation {
  readonly projectId: ProjectId;
  readonly token: symbol;
}

export interface ProjectOperationLease {
  readonly projectId: ProjectId;
  readonly token: symbol;
}

const removalTokenByProjectId = new Map<ProjectId, symbol>();
const activeOperationTokensByProjectId = new Map<ProjectId, Set<symbol>>();
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

export function hasActiveProjectOperations(projectId: ProjectId): boolean {
  return (activeOperationTokensByProjectId.get(projectId)?.size ?? 0) > 0;
}

export function releaseProjectRemoval(reservation: ProjectRemovalReservation): void {
  if (removalTokenByProjectId.get(reservation.projectId) !== reservation.token) return;
  removalTokenByProjectId.delete(reservation.projectId);
  resolveProjectDrainWaiters(reservation.projectId);
}

export function tryBeginProjectOperation(projectId: ProjectId): ProjectOperationLease | null {
  if (removalTokenByProjectId.has(projectId)) return null;
  const token = Symbol(`project-operation:${projectId}`);
  const activeTokens = activeOperationTokensByProjectId.get(projectId) ?? new Set<symbol>();
  activeTokens.add(token);
  activeOperationTokensByProjectId.set(projectId, activeTokens);
  return { projectId, token };
}

export function finishProjectOperation(lease: ProjectOperationLease): void {
  const activeTokens = activeOperationTokensByProjectId.get(lease.projectId);
  if (!activeTokens?.delete(lease.token)) return;
  if (activeTokens.size > 0) return;
  activeOperationTokensByProjectId.delete(lease.projectId);
  resolveProjectDrainWaiters(lease.projectId);
}

export async function waitForProjectOperationsToDrain(
  reservation: ProjectRemovalReservation,
): Promise<boolean> {
  if (removalTokenByProjectId.get(reservation.projectId) !== reservation.token) return false;
  if ((activeOperationTokensByProjectId.get(reservation.projectId)?.size ?? 0) === 0) return true;
  await new Promise<void>((resolve) => {
    const waiters = drainWaitersByProjectId.get(reservation.projectId) ?? new Set<() => void>();
    waiters.add(resolve);
    drainWaitersByProjectId.set(reservation.projectId, waiters);
  });
  return removalTokenByProjectId.get(reservation.projectId) === reservation.token;
}

export function resetProjectRemovalCoordinationForTests(): void {
  removalTokenByProjectId.clear();
  activeOperationTokensByProjectId.clear();
  for (const projectId of drainWaitersByProjectId.keys()) {
    resolveProjectDrainWaiters(projectId);
  }
}

import type { Case } from '@nexlegtiq/shared-contracts';
import { conditionFor } from '@nexlegtiq/shared-types';
import type { Permission, Role } from '@nexlegtiq/shared-types';

/** The tabs of the legal-file page, in order (frontend.md#legal-file-page); `details` is the default. */
export const FILE_TABS = [
  'details',
  'sessions',
  'documents',
  'parties',
  'timeline',
  'tasks',
  'billing',
  'ai',
  'notes',
  'audit',
] as const;
export type FileTab = (typeof FILE_TABS)[number];

/** Tabs that only some roles may open: the API refuses their data to everyone else (D-096 billing, audit, AI). */
const TAB_PERMISSIONS: Partial<Record<FileTab, readonly Permission[]>> = {
  billing: ['view:all:invoices', 'view:assigned:invoices'],
  ai: ['use:ai'],
  audit: ['view:audit'],
};

export const visibleTabs = (can: (permission: Permission) => boolean): FileTab[] =>
  FILE_TABS.filter((tab) => TAB_PERMISSIONS[tab]?.some(can) ?? true);

/** The tab in `?tab=`, or `details` when it is missing, unknown or not open to the user (a shared link never breaks). */
export function readTab(params: URLSearchParams, visible: readonly FileTab[]): FileTab {
  const tab = params.get('tab');
  return visible.find((key) => key === tab) ?? 'details';
}

export interface FileUser {
  readonly id: string;
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

export interface FileActions {
  readonly edit: boolean;
  readonly reassign: boolean;
  readonly changeStatus: boolean;
  readonly archive: boolean;
  readonly delete: boolean;
  /** Setting or lifting confidentiality: office manager or the file's responsible lawyer (D-096). */
  readonly confidentiality: boolean;
  /** Billing terms are written only with `generate:invoice` (D-096). */
  readonly billing: boolean;
}

/** Assigned = responsible lawyer, responsible paralegal or a team member (D-051). */
export const isAssigned = (file: Case, userId: string): boolean =>
  file.responsibleLawyer.id === userId ||
  file.responsibleParalegal?.id === userId ||
  file.team.some((member) => member.id === userId);

/** Holds `permission`; a conditional cell (a lawyer's `close:case`) counts only for the responsible lawyer (D-081). */
function holds(file: Case, user: FileUser, permission: Permission): boolean {
  if (!user.permissions.includes(permission)) return false;
  return conditionFor(user.role, permission) === undefined || file.responsibleLawyer.id === user.id;
}

const READ_ONLY: FileActions = {
  edit: false,
  reassign: false,
  changeStatus: false,
  archive: false,
  delete: false,
  confidentiality: false,
  billing: false,
};

/**
 * What the header offers (UI only: the API re-checks every call, D-051). An archived file is read-only for everyone
 * (D-052), so it offers nothing.
 */
export function fileActions(file: Case, user: FileUser): FileActions {
  if (file.status === 'ARCHIVED') return READ_ONLY;
  const can = (permission: Permission) => holds(file, user, permission);
  const edit = can('edit:any:case') || (can('edit:assigned:case') && isAssigned(file, user.id));
  const lifecycle = can('close:case') || can('reopen:case');
  return {
    edit,
    reassign: can('edit:any:case'),
    changeStatus: lifecycle,
    archive: lifecycle,
    // The API checks a delete as a write too (D-096).
    delete: can('delete:case') && can('edit:any:case'),
    confidentiality:
      edit && (user.role === 'OFFICE_MANAGER' || file.responsibleLawyer.id === user.id),
    billing: edit && can('generate:invoice'),
  };
}

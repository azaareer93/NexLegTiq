import type { Task } from '@nexlegtiq/shared-contracts';
import { create } from 'zustand';

interface TaskDrawerState {
  readonly open: boolean;
  /** The task shown, or null for a new one. */
  readonly task: Task | null;
  /** A new task's file (its Tasks tab, or Ctrl+Alt+T on a file page); none = a personal task (D-098). */
  readonly fileId: string | null;
  /** On an archived file nothing can change (D-052). */
  readonly readOnly: boolean;
}

const CLOSED: TaskDrawerState = { open: false, task: null, fileId: null, readOnly: false };

/** The one task drawer of the app (mounted by the shell): opened by cards, rows, "New task", + Task and Ctrl+Alt+T. */
export const useTaskDrawer = create<TaskDrawerState>(() => CLOSED);

export const openTaskDrawer = (
  options: Partial<Pick<TaskDrawerState, 'task' | 'fileId' | 'readOnly'>> = {},
): void =>
  useTaskDrawer.setState({
    ...CLOSED,
    ...options,
    fileId: options.task?.file?.id ?? options.fileId ?? null,
    open: true,
  });

export const closeTaskDrawer = (): void => useTaskDrawer.setState(CLOSED);

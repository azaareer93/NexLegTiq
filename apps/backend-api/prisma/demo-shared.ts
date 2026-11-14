import type { Prisma } from '../src/generated/prisma/client';

/** Where the demo PDFs go; null = skip documents (no storage configured). */
export type PutObject = ((key: string, body: Buffer) => Promise<void>) | null;

export const DAY = 86_400_000;
export const RATE = '250.00';
export const TAX = '16';
export const CURRENCY = 'ILS';
/** Every person and company is invented; the `.test` domain can never receive mail (D-007). */
export const DOMAIN = 'demo.nexlegtiq.test';

export const COURT_TYPES = new Set(['LITIGATION', 'CRIMINAL']);
export const at = <T>(list: readonly T[], i: number): T => list[i % list.length] as T;
export const day = (offset: number) => {
  const d = new Date(Date.now() + offset * DAY);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

export interface Staff {
  readonly managerId: string;
  readonly lawyers: readonly string[];
  readonly paralegalId: string;
}

export interface DemoFile {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly lawyerId: string;
  readonly paralegalId: string | null;
  readonly clientId: string;
  readonly openedDaysAgo: number;
}

/** The seed client or the transaction the content is written in. */
export type Db = Prisma.TransactionClient;

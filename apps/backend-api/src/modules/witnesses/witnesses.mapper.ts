import type { Witness, WitnessStatement } from '@nexlegtiq/shared-contracts';

export const WITNESS_SELECT = {
  id: true,
  fileId: true,
  fullName: true,
  isExpert: true,
  expertiseArea: true,
  phone: true,
  email: true,
  address: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { statements: true } },
} as const;

export const STATEMENT_SELECT = {
  id: true,
  witnessId: true,
  statementDate: true,
  text: true,
  isUnderOath: true,
  createdAt: true,
  updatedAt: true,
  recordedBy: { select: { id: true, fullName: true } },
  session: { select: { id: true, startsAt: true } },
} as const;

type WitnessRow = Omit<Witness, 'statementCount' | 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
  _count: { statements: number };
};
type StatementRow = Omit<
  WitnessStatement,
  'statementDate' | 'session' | 'createdAt' | 'updatedAt'
> & {
  statementDate: Date;
  session: { id: string; startsAt: Date } | null;
  createdAt: Date;
  updatedAt: Date;
};

export const toDbDate = (value: string): Date => new Date(`${value}T00:00:00Z`);
/** At most this many witnesses per file, or statements per witness, in one answer. */
export const LIMIT = 500;

export function toWitness({ _count, createdAt, updatedAt, ...row }: WitnessRow): Witness {
  return {
    ...row,
    statementCount: _count.statements,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

export function toStatement(row: StatementRow): WitnessStatement {
  return {
    ...row,
    statementDate: row.statementDate.toISOString().slice(0, 10),
    session: row.session && { id: row.session.id, startsAt: row.session.startsAt.toISOString() },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Free text (testimony, witness notes) is never audited, only that it changed. */
export function withoutText(values: Record<string, unknown>, key: 'text' | 'notes') {
  if (!(key in values)) return values;
  const { [key]: _text, ...others } = values;
  return { ...others, [`${key}Changed`]: true };
}

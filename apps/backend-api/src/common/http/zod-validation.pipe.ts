import { Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { ApiErrorDetail } from '@nexlegtiq/shared-types';
import type { z } from 'zod';

import { ValidationException } from '../errors/app.exception';

/** `title` / `clients.0.id` / `(root)` for whole-body errors. */
export function zodIssuesToDetails(issues: readonly z.core.$ZodIssue[]): ApiErrorDetail[] {
  return issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
    message: issue.message,
  }));
}

/**
 * Validates and parses a body/query/param with a contract schema from shared-contracts. Returns the parsed (coerced,
 * defaulted, stripped) value; throws VAL-001 with one detail per issue.
 *
 *   `@Body(new ZodValidationPipe(CreateCaseSchema)) dto: CreateCaseInput`
 */
@Injectable()
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<unknown, z.output<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ValidationException(zodIssuesToDetails(result.error.issues));
    return result.data;
  }
}

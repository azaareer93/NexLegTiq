import { z } from 'zod';

import { PaginatedResult } from './paginated-result';
import { zodIssuesToDetails, ZodValidationPipe } from './zod-validation.pipe';
import { ValidationException } from '../errors/app.exception';

describe('ZodValidationPipe', () => {
  const schema = z.object({
    title: z.string().min(3),
    limit: z.coerce.number().int().max(100).default(20),
    clients: z.array(z.object({ id: z.uuid() })).optional(),
  });
  const pipe = new ZodValidationPipe(schema);

  it('should return the parsed value with coercion, defaults and unknown keys stripped', () => {
    expect(pipe.transform({ title: 'Lease', extra: 'x' })).toEqual({ title: 'Lease', limit: 20 });
    expect(pipe.transform({ title: 'Lease', limit: '50' })).toEqual({ title: 'Lease', limit: 50 });
  });

  it('should throw VAL-001 with one detail per invalid field when input is invalid', () => {
    // Arrange
    const input = { title: 'x', limit: '500', clients: [{ id: 'nope' }] };

    // Act
    const act = (): unknown => pipe.transform(input);

    // Assert
    expect(act).toThrow(ValidationException);
    try {
      act();
    } catch (error) {
      const exception = error as ValidationException;
      expect(exception.code).toBe('VAL-001');
      expect(exception.details?.map((d) => d.field)).toEqual(['title', 'limit', 'clients.0.id']);
    }
  });

  it('should report root-level errors as (root)', () => {
    const result = z.object({ a: z.string() }).safeParse('not-an-object');

    expect(result.success).toBe(false);
    if (!result.success) expect(zodIssuesToDetails(result.error.issues)[0]?.field).toBe('(root)');
  });
});

describe('PaginatedResult', () => {
  it('should compute totalPages and hasMore', () => {
    expect(PaginatedResult.of([1, 2], { page: 1, limit: 2, total: 5 }).pagination).toEqual({
      page: 1,
      limit: 2,
      total: 5,
      totalPages: 3,
      hasMore: true,
    });
  });

  it('should not divide by zero when limit is 0', () => {
    expect(PaginatedResult.of([], { page: 1, limit: 0, total: 10 }).pagination).toMatchObject({
      totalPages: 0,
      hasMore: false,
    });
  });

  it('should report no more pages on the last page or when empty', () => {
    expect(PaginatedResult.of([5], { page: 3, limit: 2, total: 5 }).pagination.hasMore).toBe(false);
    expect(PaginatedResult.of([], { page: 1, limit: 20, total: 0 }).pagination).toMatchObject({
      totalPages: 0,
      hasMore: false,
    });
  });
});

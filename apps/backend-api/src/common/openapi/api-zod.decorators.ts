import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

/** Converts a contract schema to an OpenAPI 3.0 schema. `input` for request bodies/queries, `output` for responses. */
export function zodToOpenApi(schema: z.ZodType, io: 'input' | 'output'): SchemaObject {
  const openApi: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { target: 'openapi-3.0', io, unrepresentable: 'any' }),
  };
  delete openApi['$schema'];
  return openApi as SchemaObject;
}

const META_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['timestamp', 'requestId'],
  properties: {
    timestamp: { type: 'string', format: 'date-time' },
    requestId: { type: 'string' },
  },
};

const PAGINATION_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['page', 'limit', 'total', 'totalPages', 'hasMore'],
  properties: {
    page: { type: 'integer' },
    limit: { type: 'integer' },
    total: { type: 'integer' },
    totalPages: { type: 'integer' },
    hasMore: { type: 'boolean' },
  },
};

/** The success envelope around `data` (api-conventions.md#shape). */
export function envelopeSchema(
  data: SchemaObject,
  options: { paginated?: boolean } = {},
): SchemaObject {
  const meta: SchemaObject = options.paginated
    ? {
        ...META_SCHEMA,
        required: [...(META_SCHEMA.required ?? []), 'pagination'],
        properties: { ...META_SCHEMA.properties, pagination: PAGINATION_SCHEMA },
      }
    : META_SCHEMA;
  return {
    type: 'object',
    required: ['success', 'data', 'meta'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      data: options.paginated ? { type: 'array', items: data } : data,
      meta,
    },
  };
}

/** Request body documented from its Zod contract. */
export function ApiZodBody(schema: z.ZodType): MethodDecorator {
  return applyDecorators(ApiBody({ schema: zodToOpenApi(schema, 'input') }));
}

/** Query parameters documented from a Zod object contract (one entry per key). */
export function ApiZodQuery(schema: z.ZodObject): MethodDecorator {
  const json = zodToOpenApi(schema, 'input');
  const required = new Set(json.required ?? []);
  const decorators = Object.entries(json.properties ?? {}).map(([name, property]) =>
    ApiQuery({ name, required: required.has(name), schema: property as SchemaObject }),
  );
  return applyDecorators(...decorators);
}

/**
 * Response documented from its Zod contract, wrapped in the success envelope. For list endpoints pass the item
 * schema and `{ paginated: true }`.
 */
export function ApiZodResponse(
  status: number,
  schema: z.ZodType,
  options: { description?: string; paginated?: boolean } = {},
): MethodDecorator {
  return applyDecorators(
    ApiResponse({
      status,
      ...(options.description && { description: options.description }),
      schema: envelopeSchema(zodToOpenApi(schema, 'output'), options),
    }),
  );
}

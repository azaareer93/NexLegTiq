import { DECORATORS } from '@nestjs/swagger';
import { z } from 'zod';

import {
  ApiZodBody,
  ApiZodQuery,
  ApiZodResponse,
  envelopeSchema,
  zodToOpenApi,
} from './api-zod.decorators';

const ThingSchema = z.object({
  title: z.string().min(3),
  priority: z.enum(['LOW', 'HIGH']).default('LOW'),
  note: z.string().nullable(),
});

function metadataOf(decorator: MethodDecorator, key: string): unknown {
  class Target {
    handler(): void {
      return undefined;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(Target.prototype, 'handler');
  if (!descriptor) throw new Error('no descriptor');
  decorator(Target.prototype, 'handler', descriptor);
  return Reflect.getMetadata(key, descriptor.value as object);
}

describe('zodToOpenApi', () => {
  it('should produce an OpenAPI 3.0 schema without $schema', () => {
    const schema = zodToOpenApi(ThingSchema, 'output');

    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 3 },
        note: { type: 'string', nullable: true },
      },
    });
  });

  it('should treat defaulted fields as optional on input and required on output', () => {
    expect(zodToOpenApi(ThingSchema, 'input').required).not.toContain('priority');
    expect(zodToOpenApi(ThingSchema, 'output').required).toContain('priority');
  });
});

describe('envelopeSchema', () => {
  it('should wrap data and require meta', () => {
    expect(envelopeSchema({ type: 'string' })).toMatchObject({
      required: ['success', 'data', 'meta'],
      properties: { data: { type: 'string' } },
    });
  });

  it('should make data an array and add meta.pagination when paginated', () => {
    const schema = envelopeSchema({ type: 'string' }, { paginated: true });

    expect(schema.properties?.['data']).toEqual({ type: 'array', items: { type: 'string' } });
    expect((schema.properties?.['meta'] as { required: string[] }).required).toContain(
      'pagination',
    );
  });
});

describe('Api* decorators', () => {
  it('ApiZodBody should document the input schema', () => {
    const [body] = metadataOf(ApiZodBody(ThingSchema), DECORATORS.API_PARAMETERS) as [
      { schema: unknown },
    ];

    expect(body.schema).toMatchObject({ type: 'object', required: ['title', 'note'] });
  });

  it('ApiZodQuery should document one query parameter per key', () => {
    const params = metadataOf(ApiZodQuery(ThingSchema), DECORATORS.API_PARAMETERS) as {
      name: string;
      required: boolean;
    }[];

    expect(params.map((p) => [p.name, p.required])).toEqual(
      expect.arrayContaining([
        ['title', true],
        ['priority', false],
      ]),
    );
  });

  it('ApiZodResponse should document the enveloped response', () => {
    const responses = metadataOf(
      ApiZodResponse(201, ThingSchema),
      DECORATORS.API_RESPONSE,
    ) as Record<string, { schema: { required: string[] } }>;

    expect(responses['201']?.schema.required).toEqual(['success', 'data', 'meta']);
  });

  it('ApiZodResponse should document a paginated list with a description', () => {
    const responses = metadataOf(
      ApiZodResponse(200, ThingSchema, { paginated: true, description: 'Things' }),
      DECORATORS.API_RESPONSE,
    ) as Record<
      string,
      { description: string; schema: { properties: { data: { type: string } } } }
    >;

    expect(responses['200']?.description).toBe('Things');
    expect(responses['200']?.schema.properties.data.type).toBe('array');
  });
});

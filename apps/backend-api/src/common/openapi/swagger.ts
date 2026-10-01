import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const SWAGGER_PATH = 'api/docs';
export const SWAGGER_JSON_PATH = 'api/docs-json';

/** Swagger UI at /api/docs and OpenAPI JSON at /api/docs-json (api-conventions.md). */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('NexLegTiq API')
    .setDescription(
      'All responses use the envelope `{ success, data | error, meta }`. Errors carry a code from ' +
        '`docs/context/api-conventions.md#error-codes`.',
    )
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
    .addCookieAuth('nlq_rt', { type: 'apiKey', in: 'cookie', name: 'nlq_rt' }, 'refresh')
    // Every route needs the access token unless marked @Public() (D-082).
    .addSecurityRequirements('JWT')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_PATH, app, document, { jsonDocumentUrl: SWAGGER_JSON_PATH });
}

import { AppException } from './app.exception';
import { isPrismaError } from './prisma-error';

/**
 * What the exception filter logs about an error. Client-caused errors can carry client data in their message or
 * properties (body-parser attaches the raw body; V8 JSON errors quote it; Nest 404s quote the URL with its query), and
 * Prisma messages quote query arguments — so only safe fields are kept. Our own AppException messages are
 * developer-written and safe. Unexpected (5xx) errors keep message and stack for debugging.
 */
export function loggableError(exception: unknown, status: number): Record<string, unknown> {
  if (!(exception instanceof Error)) return { type: typeof exception };
  const type = exception.name;
  if (isPrismaError(exception)) {
    const meta = (exception as { meta?: { modelName?: unknown; target?: unknown } }).meta;
    return { type, prismaCode: exception.code, model: meta?.modelName, target: meta?.target };
  }
  if (exception instanceof AppException) {
    return { type, message: exception.message, ...(status >= 500 && { stack: exception.stack }) };
  }
  if (status < 500) return { type };
  return { type, message: exception.message, stack: exception.stack };
}

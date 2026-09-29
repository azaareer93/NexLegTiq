import type { IncomingMessage } from 'node:http';

export type RoutedRequest = IncomingMessage & { baseUrl?: string; route?: { path?: unknown } };

/**
 * The matched route template of an Express request (`/api/v1/cases/:id`), or undefined when no real route matched.
 * Nest answers unknown routes through a catch-all (`/api/v1{/*splat}`), which is treated as unmatched.
 */
export function routeTemplateOf(req: RoutedRequest | undefined): string | undefined {
  const path = req?.route?.path;
  if (typeof path !== 'string' || path.includes('*')) return undefined;
  return `${req?.baseUrl ?? ''}${path}`;
}

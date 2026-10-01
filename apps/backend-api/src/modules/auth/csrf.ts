import { PermissionDeniedException } from '../../common/errors/app.exception';

/**
 * CSRF defence for the cookie-authenticated endpoints, refresh and logout (D-055): besides SameSite=Lax, the request
 * must come from an allowed SPA origin and carry `X-Requested-With: XMLHttpRequest` (a custom header a cross-site form
 * or image cannot send without a CORS preflight). Failure is 403 AUTH-100.
 */
export function assertCookieRequestOrigin(
  headers: Record<string, string | string[] | undefined>,
  allowedOrigins: readonly string[],
): void {
  const origin = single(headers['origin']);
  const requestedWith = single(headers['x-requested-with']);
  if (origin === undefined || !allowedOrigins.includes(origin) || requestedWith !== 'XMLHttpRequest') {
    throw new PermissionDeniedException('Cross-site request rejected');
  }
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

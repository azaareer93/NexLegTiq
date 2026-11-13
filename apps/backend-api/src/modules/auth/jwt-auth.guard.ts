import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AccessTokenVerifier } from './access-token-verifier';
import { SessionActivity } from './session-activity';
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator';
import type { AuthPrincipal } from '../../common/context/request-context';

type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthPrincipal;
};

/**
 * Global, deny-by-default authentication (auth-rbac.md: JwtAuthGuard → PermissionsGuard). Registered before
 * PermissionsGuard. Routes opt out with `@Public()`. The Bearer access token (HS256, 15 min) only identifies the user:
 * role, active flags and office status are reloaded from the database on every request (`AccessTokenVerifier`), so a
 * demotion, deactivation or office suspension applies on the next request rather than when the token expires (D-081,
 * D-082). With EMAIL_VERIFICATION_ENFORCED, an email still unverified 7 days after signup is refused with 403 AUTH-010
 * (D-083). Each request also counts as activity of its session (MVP-168).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenVerifier,
    private readonly activity: SessionActivity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { principal } = await this.tokens.verify(bearerToken(request.headers['authorization']));
    request.user = principal;
    // Any authenticated request is activity: it keeps the session refreshable (MVP-168).
    if (principal.sessionId) await this.activity.touch(principal.officeId, principal.sessionId);
    return true;
  }
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

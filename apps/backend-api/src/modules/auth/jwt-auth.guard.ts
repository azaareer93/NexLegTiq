import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AccessTokenVerifier } from './access-token-verifier';
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
 * (D-083).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenVerifier,
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
    request.user = (
      await this.tokens.verify(bearerToken(request.headers['authorization']))
    ).principal;
    return true;
  }
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

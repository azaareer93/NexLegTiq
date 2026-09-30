import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Observable } from 'rxjs';

import type { AuthPrincipal, RequestContext } from '../context/request-context';

/**
 * Copies the authenticated principal (set on `req.user` by the JWT guard, MVP-40) into CLS, where the tenant extension,
 * services and loggers read it. The office never comes from the body, path or query (D-013, D-018). Public routes have
 * no principal and get no office: any tenant query there fails with TenantContextMissingError.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const principal = context.switchToHttp().getRequest<{ user?: AuthPrincipal }>().user;
    if (principal) {
      this.cls.set('userId', principal.userId);
      this.cls.set('officeId', principal.officeId);
      this.cls.set('role', principal.role);
      this.cls.set('permissions', principal.permissions);
      this.cls.set('realm', principal.realm);
    }
    return next.handle();
  }
}

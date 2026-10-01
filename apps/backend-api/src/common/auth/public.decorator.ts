import { SetMetadata } from '@nestjs/common';

/** Opens a route to unauthenticated callers. JwtAuthGuard is global and deny-by-default (D-082). */
export const IS_PUBLIC_KEY = 'nexlegtiq:public';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

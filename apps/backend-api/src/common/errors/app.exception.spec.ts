import { HttpStatus } from '@nestjs/common';

import {
  AppException,
  BusinessRuleException,
  ResourceConflictException,
  PermissionDeniedException,
  ResourceNotFoundException,
  DependencyUnavailableException,
  ValidationException,
} from './app.exception';
import { isPrismaError, mapPrismaError } from './prisma-error';

describe('AppException family', () => {
  it.each([
    [new ValidationException([{ field: 'title', message: 'Required' }]), 'VAL-001', HttpStatus.BAD_REQUEST],
    [new ResourceNotFoundException(), 'RES-001', HttpStatus.NOT_FOUND],
    [new ResourceConflictException('RES-002'), 'RES-002', HttpStatus.CONFLICT],
    [new PermissionDeniedException(), 'AUTH-100', HttpStatus.FORBIDDEN],
    [new BusinessRuleException('BIZ-004', 'Session conflict'), 'BIZ-004', HttpStatus.CONFLICT],
    [new BusinessRuleException('BIZ-003', 'Open tasks'), 'BIZ-003', HttpStatus.UNPROCESSABLE_ENTITY],
    [new DependencyUnavailableException(), 'SYS-002', HttpStatus.SERVICE_UNAVAILABLE],
  ])('should carry code and catalog status for %s', (exception, code, status) => {
    expect(exception).toBeInstanceOf(AppException);
    expect(exception.code).toBe(code);
    expect(exception.status).toBe(status);
  });

  it('should name the error after its class', () => {
    expect(new ResourceNotFoundException().name).toBe('ResourceNotFoundException');
  });
});

describe('Prisma error mapping', () => {
  function prismaError(code?: string, name = 'PrismaClientKnownRequestError'): Error & { code?: string } {
    return Object.assign(Object.defineProperty(new Error('db'), 'name', { value: name }), { code });
  }

  it.each([
    ['P2002', 'RES-002'],
    ['P2025', 'RES-001'],
    ['P2034', 'RES-003'],
    ['P2003', 'DB-001'],
    [undefined, 'DB-001'],
  ])('should map %s to %s', (prismaCode, expected) => {
    expect(mapPrismaError(prismaError(prismaCode))).toBe(expected);
  });

  it('should recognise Prisma errors by class name only', () => {
    expect(isPrismaError(prismaError('P2002'))).toBe(true);
    expect(isPrismaError(prismaError(undefined, 'PrismaClientInitializationError'))).toBe(true);
    expect(isPrismaError(new Error('plain'))).toBe(false);
    expect(isPrismaError({ name: 'PrismaClientKnownRequestError' })).toBe(false);
  });
});

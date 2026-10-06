import { BusinessRuleException } from './app.exception';
import { loggableError } from './error-log';

function withName<T extends Error>(error: T, name: string): T {
  return Object.defineProperty(error, 'name', { value: name });
}

describe('loggableError', () => {
  it('should drop message and body of client (4xx) framework errors', () => {
    // body-parser attaches the raw body, and V8 quotes part of it in the JSON error message.
    const error = Object.assign(new SyntaxError('Unexpected token in JSON at "password":"Sup3r'), {
      body: '{"password":"Sup3rSecret!"',
      status: 400,
    });

    const logged = loggableError(error, 400);

    expect(logged).toEqual({ type: 'SyntaxError' });
    expect(JSON.stringify(logged)).not.toContain('Sup3r');
  });

  it('should keep our own AppException message (developer-written)', () => {
    expect(
      loggableError(new BusinessRuleException('BIZ-003', 'Open tasks block close'), 422),
    ).toEqual({
      type: 'BusinessRuleException',
      message: 'Open tasks block close',
    });
  });

  it('should log only name, code and model for Prisma errors (messages quote query args)', () => {
    const error = Object.assign(
      withName(
        new Error('Invalid value "401234567" for nationalId'),
        'PrismaClientKnownRequestError',
      ),
      { code: 'P2002', meta: { modelName: 'Party', target: ['officeId', 'nationalId'] } },
    );

    const logged = loggableError(error, 409);

    expect(logged).toEqual({
      type: 'PrismaClientKnownRequestError',
      prismaCode: 'P2002',
      model: 'Party',
      target: ['officeId', 'nationalId'],
    });
    expect(JSON.stringify(logged)).not.toContain('401234567');
  });

  it('should keep message and stack for unexpected 5xx errors', () => {
    expect(loggableError(new TypeError('cannot read x of undefined'), 500)).toMatchObject({
      type: 'TypeError',
      message: 'cannot read x of undefined',
      stack: expect.any(String),
    });
  });

  it('should describe non-Error throwables by type only', () => {
    expect(loggableError('a string', 500)).toEqual({ type: 'string' });
  });
});

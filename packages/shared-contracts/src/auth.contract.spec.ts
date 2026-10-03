import {
  AuthSessionSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  ResendVerificationRequestSchema,
  VerifyEmailRequestSchema,
} from './auth.contract.js';

describe('LoginRequestSchema', () => {
  it('should normalise the email and default rememberMe', () => {
    expect(LoginRequestSchema.parse({ email: '  Lawyer@Example.TEST ', password: 'x' })).toEqual({
      email: 'lawyer@example.test',
      password: 'x',
      rememberMe: false,
    });
  });

  it.each([
    [{ email: 'not-an-email', password: 'x' }],
    [{ email: 'a@b.test', password: '' }],
    [{ email: 'a@b.test', password: 'x'.repeat(257) }],
  ])('should reject %j', (body) => {
    expect(LoginRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('AuthSessionSchema', () => {
  it('should reject an unknown permission or role in the user', () => {
    const session = {
      accessToken: 't',
      expiresIn: 900,
      user: {
        id: '01920000-0000-7000-8000-0000000000aa',
        fullName: 'Lawyer',
        email: 'a@b.test',
        role: 'LAWYER',
        officeId: '01920000-0000-7000-8000-00000000000a',
        officeName: 'Office',
        uiLanguage: 'AR',
        permissions: ['create:case'],
        emailVerified: false,
        verifyBy: '2026-10-08T12:00:00.000Z',
      },
    };
    expect(AuthSessionSchema.safeParse(session).success).toBe(true);
    expect(AuthSessionSchema.safeParse({ ...session, user: { ...session.user, permissions: ['root'] } }).success).toBe(false);
    expect(AuthSessionSchema.safeParse({ ...session, user: { ...session.user, role: 'GOD' } }).success).toBe(false);
  });
});

describe('RegisterRequestSchema', () => {
  const valid = {
    fullName: '  عمر المصري ',
    email: ' Omar@Example.TEST',
    password: 'Testtesttest1',
    officeName: 'مكتب المصري للمحاماة',
    accountType: 'SOLO',
    currency: 'ils',
    acceptTerms: true,
    acceptPrivacy: true,
  };

  it('should normalise text and apply the Palestine defaults', () => {
    expect(RegisterRequestSchema.parse(valid)).toEqual({
      ...valid,
      fullName: 'عمر المصري',
      email: 'omar@example.test',
      currency: 'ILS',
      jurisdiction: 'PALESTINE',
      defaultLanguage: 'AR',
    });
  });

  it.each([
    ['a short password', { password: 'Short1a' }, 'validation.password.tooShort'],
    ['a password without a digit', { password: 'NoDigitsHere' }, 'validation.password.weak'],
    ['a well-known password', { password: 'Password123' }, 'validation.password.common'],
    ['the email as password', { email: 'Omar123456@x.test', password: 'Omar123456' }, 'validation.password.sameAsEmail'],
    ['unaccepted terms', { acceptTerms: false }, 'validation.mustAcceptTerms'],
    ['missing privacy acceptance', { acceptPrivacy: undefined }, 'validation.mustAcceptPrivacy'],
    ['a control character in a name', { fullName: 'Omar\u0000' }, 'validation.invalidCharacters'],
    ['an unknown jurisdiction', { jurisdiction: 'MARS' }, undefined],
    ['an unknown account type', { accountType: 'ENTERPRISE' }, undefined],
    ['a bad currency', { currency: 'SHEKEL' }, 'validation.currency'],
    ['an unknown currency code', { currency: 'ABC' }, 'validation.currency'],
    ['a bidi override in a name', { officeName: 'Office ‮' }, 'validation.invalidCharacters'],
    ['missing terms acceptance', { acceptTerms: undefined }, 'validation.mustAcceptTerms'],
    ['an overlong password', { password: 'Aa1'.repeat(90) }, 'validation.tooLong'],
    ['a bad phone', { phone: 'call me' }, 'validation.phone'],
  ])('should reject %s', (_label, change, message) => {
    const result = RegisterRequestSchema.safeParse({ ...valid, ...change });
    expect(result.success).toBe(false);
    if (message) expect(result.error?.issues.map((issue) => issue.message)).toContain(message);
  });

  it('should keep zero-width non-joiners in Arabic names', () => {
    expect(RegisterRequestSchema.parse({ ...valid, fullName: 'عمر‌المصري' }).fullName).toBe('عمر‌المصري');
  });

  it('should accept an international phone number', () => {
    expect(RegisterRequestSchema.parse({ ...valid, phone: '+970 59 123 4567' }).phone).toBe('+970 59 123 4567');
  });
});

describe('ResendVerificationRequestSchema', () => {
  it('should normalise the email and reject junk', () => {
    expect(ResendVerificationRequestSchema.parse({ email: ' A@B.Test ' })).toEqual({ email: 'a@b.test' });
    expect(ResendVerificationRequestSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });
});

describe('VerifyEmailRequestSchema', () => {
  it('should accept a link token and reject junk', () => {
    expect(VerifyEmailRequestSchema.safeParse({ token: 'A'.repeat(43) }).success).toBe(true);
    expect(VerifyEmailRequestSchema.safeParse({ token: 'short' }).success).toBe(false);
  });
});

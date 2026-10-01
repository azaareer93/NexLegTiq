import { AuthSessionSchema, LoginRequestSchema } from './auth.contract.js';

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
      },
    };
    expect(AuthSessionSchema.safeParse(session).success).toBe(true);
    expect(AuthSessionSchema.safeParse({ ...session, user: { ...session.user, permissions: ['root'] } }).success).toBe(false);
    expect(AuthSessionSchema.safeParse({ ...session, user: { ...session.user, role: 'GOD' } }).success).toBe(false);
  });
});

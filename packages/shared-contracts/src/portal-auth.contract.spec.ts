import { CreatePortalInvitationSchema } from './client-portal.contract.js';
import {
  PortalAcceptInviteRequestSchema,
  PortalInvitePreviewRequestSchema,
  PortalLoginRequestSchema,
} from './portal-auth.contract.js';

const TOKEN = 'a'.repeat(43);

describe('client portal contracts (D-157)', () => {
  it('should take an invitation by email with an optional contact person', () => {
    expect(CreatePortalInvitationSchema.parse({ email: 'Nour@Example.test' }).email).toBe(
      'nour@example.test',
    );
    expect(CreatePortalInvitationSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(
      CreatePortalInvitationSchema.safeParse({ email: 'n@example.test', contactPersonId: 'x' })
        .success,
    ).toBe(false);
  });

  it('should need both acceptances, a policy password and a name to accept', () => {
    const body = {
      token: TOKEN,
      fullName: 'Nour Haddad',
      password: 'Testtesttest1',
      acceptTerms: true,
      acceptPrivacy: true,
    };
    expect(PortalAcceptInviteRequestSchema.safeParse(body).success).toBe(true);
    expect(PortalAcceptInviteRequestSchema.safeParse({ ...body, acceptTerms: false }).success).toBe(
      false,
    );
    // The password policy is applied by the service for new accounts only; an existing account's password just has to be sent.
    expect(PortalAcceptInviteRequestSchema.safeParse({ ...body, password: 'short' }).success).toBe(
      true,
    );
    expect(PortalAcceptInviteRequestSchema.safeParse({ ...body, password: '' }).success).toBe(
      false,
    );
    expect(PortalAcceptInviteRequestSchema.safeParse({ ...body, fullName: 'N' }).success).toBe(
      false,
    );
  });

  it('should take a login and a preview token', () => {
    expect(
      PortalLoginRequestSchema.safeParse({ email: 'n@example.test', password: 'x' }).success,
    ).toBe(true);
    expect(PortalLoginRequestSchema.safeParse({ email: 'n@example.test' }).success).toBe(false);
    expect(PortalInvitePreviewRequestSchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(PortalInvitePreviewRequestSchema.safeParse({ token: '' }).success).toBe(false);
  });
});

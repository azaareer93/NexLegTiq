import { ClsServiceManager } from 'nestjs-cls';

import { InvitationLinks } from './invitation-links';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const INVITATION = '01920000-0000-7000-8000-0000000000bb';
const cls = ClsServiceManager.getClsService<RequestContext>();
const runner = new TenantRunner(cls);

describe('InvitationLinks (worker side, D-134)', () => {
  const now = new Date('2026-10-23T10:00:00Z');

  function setup(invitation: object | null, rotated = 1) {
    const officeInvitation = {
      findFirst: jest.fn().mockResolvedValue(invitation),
      updateMany: jest.fn().mockResolvedValue({ count: rotated }),
    };
    const prisma = { db: { officeInvitation } } as unknown as PrismaService;
    const config = new AppConfig(
      parseEnv(testEnv({ NODE_ENV: 'development', OFFICE_APP_URL: 'https://app.test/' })),
    );
    return { links: new InvitationLinks(prisma, cls, config), officeInvitation };
  }

  const pending = {
    email: 'nadia@b.test',
    expiresAt: new Date('2026-10-28T09:00:00Z'),
    message: null,
    office: { name: 'Adel & Partners', defaultLanguage: 'AR' },
    invitedBy: { fullName: 'Basma' },
  };

  it('should store only the hash of a new link and email it in the office language with the days left', async () => {
    const { links, officeInvitation } = setup(pending);
    const email = await runner.run({ officeId: OFFICE as never }, () =>
      links.issue(INVITATION, now),
    );
    const token = new URL(email?.vars.link ?? 'http://x').searchParams.get('token') ?? '';
    expect(email).toMatchObject({
      to: 'nadia@b.test',
      locale: 'AR',
      vars: { officeName: 'Adel & Partners', inviterName: 'Basma', days: 5, message: '' },
    });
    expect(email?.vars.link.startsWith('https://app.test/accept-invite?token=')).toBe(true);
    expect(officeInvitation.updateMany).toHaveBeenCalledWith({
      where: { id: INVITATION, status: 'PENDING' },
      data: { tokenHash: hashOpaqueToken(token) },
    });
  });

  it('should send nothing for an invitation that is no longer pending, or was revoked meanwhile', async () => {
    const gone = setup(null);
    await expect(
      runner.run({ officeId: OFFICE as never }, () => gone.links.issue(INVITATION, now)),
    ).resolves.toBeNull();
    expect(gone.officeInvitation.updateMany).not.toHaveBeenCalled();

    const raced = setup(pending, 0);
    await expect(
      runner.run({ officeId: OFFICE as never }, () => raced.links.issue(INVITATION, now)),
    ).resolves.toBeNull();
  });

  it('should refuse to run outside an office context', async () => {
    await expect(setup(pending).links.issue(INVITATION, now)).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });
});

import type { ClsService } from 'nestjs-cls';

import { PortalInvitationLinks, PortalPasswordResetLinks } from './portal-links';
import type { RequestContext } from '../../common/context/request-context';
import type { AppConfig } from '../../config/app-config';
import type { PrismaService } from '../../database/prisma.service';

const NOW = new Date('2026-11-09T10:00:00Z');
const config = { mail: { clientPortalUrl: 'https://portal.test' } } as unknown as AppConfig;
const cls = (officeId?: string) =>
  ({ isActive: () => true, get: () => officeId }) as unknown as ClsService<RequestContext>;

describe('PortalInvitationLinks (D-158)', () => {
  const row = {
    email: 'a@b.test',
    expiresAt: new Date(NOW.getTime() + 3 * 86_400_000),
    client: { displayName: 'Layla' },
    office: { name: 'Office', defaultLanguage: 'EN' },
    invitedBy: { fullName: 'Sara' },
  };
  const links = (found: object | null, rotated = 1, officeId: string | null = 'o1') => {
    const table = {
      findFirst: jest.fn().mockResolvedValue(found),
      updateMany: jest.fn().mockResolvedValue({ count: rotated }),
    };
    return {
      table,
      links: new PortalInvitationLinks(
        { db: { clientInvitation: table } } as unknown as PrismaService,
        cls(officeId ?? undefined),
        config,
      ),
    };
  };

  it('should store a new token hash and build the portal link with the days left', async () => {
    const { links: l, table } = links(row);
    const email = await l.issue('i1', NOW);
    expect(email).toMatchObject({ to: 'a@b.test', locale: 'EN' });
    expect(email?.vars).toMatchObject({ days: 3, clientName: 'Layla', inviterName: 'Sara' });
    expect(email?.vars.link).toMatch(/^https:\/\/portal\.test\/accept-invite\?token=\S{20,}$/);
    expect(table.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) } }),
    );
  });

  it('should send Arabic for an Arabic office and nothing when the invitation is gone or raced', async () => {
    const arabic = await links({
      ...row,
      office: { name: 'O', defaultLanguage: 'AR' },
    }).links.issue('i1', NOW);
    expect(arabic?.locale).toBe('AR');
    expect(await links(null).links.issue('i1', NOW)).toBeNull();
    expect(await links(row, 0).links.issue('i1', NOW)).toBeNull();
  });

  it('should refuse to run outside an office', async () => {
    await expect(links(row, 1, null).links.issue('i1', NOW)).rejects.toThrow();
  });
});

describe('PortalPasswordResetLinks (D-158)', () => {
  const resets = (
    user: object | null,
    recent: Date[] = [],
    office: object | null = { defaultLanguage: 'EN' },
  ) => {
    const tx = {
      clientUser: { findFirst: jest.fn().mockResolvedValue(user) },
      clientPasswordResetToken: {
        findMany: jest.fn().mockResolvedValue(recent.map((createdAt) => ({ createdAt }))),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
    };
    const prisma = {
      unscoped: () => ({ $transaction: (work: (t: unknown) => unknown) => work(tx) }),
      db: { office: { findFirst: jest.fn().mockResolvedValue(office) } },
    } as unknown as PrismaService;
    return { tx, links: new PortalPasswordResetLinks(prisma, config) };
  };
  const user = { email: 'a@b.test', fullName: 'Layla' };

  it('should end earlier links, store a one-hour link and email it in the office language', async () => {
    const { links, tx } = resets(user);
    const email = await links.issue('u1', NOW);
    expect(email).toMatchObject({ to: 'a@b.test', locale: 'EN' });
    expect(email?.vars).toMatchObject({ name: 'Layla', minutes: 60 });
    expect(email?.vars.link).toContain('https://portal.test/reset-password?token=');
    expect(tx.clientPasswordResetToken.updateMany).toHaveBeenCalled();
    expect(tx.clientPasswordResetToken.create).toHaveBeenCalled();
    const arabic = await resets(user, [], { defaultLanguage: 'AR' }).links.issue('u1', NOW);
    expect(arabic?.locale).toBe('AR');
    expect((await resets(user, [], null).links.issue('u1', NOW))?.locale).toBe('AR');
  });

  it('should send nothing to an unknown account, within the cooldown or past the hourly cap; a retry is exempt', async () => {
    expect(await resets(null).links.issue('u1', NOW)).toBeNull();
    const justNow = [new Date(NOW.getTime() - 10_000)];
    expect(await resets(user, justNow).links.issue('u1', NOW)).toBeNull();
    expect(await resets(user, justNow).links.issue('u1', NOW, { retry: true })).not.toBeNull();
    const five = Array.from({ length: 5 }, (_, i) => new Date(NOW.getTime() - (i + 2) * 60_000));
    expect(await resets(user, five).links.issue('u1', NOW)).toBeNull();
  });
});

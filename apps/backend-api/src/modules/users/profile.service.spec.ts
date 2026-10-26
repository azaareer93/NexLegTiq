import { Readable } from 'node:stream';

import type { ClsService } from 'nestjs-cls';

import { ProfileService } from './profile.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { StorageService } from '../../common/storage/storage.service';
import type { PrismaService } from '../../database/prisma.service';
import { jpegHeader, pngHeader } from '../documents/extraction/fixtures.test-helper';

const USER = {
  id: 'u1',
  fullName: 'Rana',
  email: 'r@example.test',
  role: 'LAWYER',
  phone: null,
  uiLanguage: 'AR',
  timezone: null,
  digitStyle: 'WESTERN',
  avatarUrl: null as string | null,
  notificationPrefs: {} as unknown,
};

function setup(user: Partial<typeof USER> = {}) {
  const row = { ...USER, ...user };
  const tx = {
    user: {
      update: jest.fn().mockImplementation(({ data }: { data: object }) => ({ ...row, ...data })),
    },
  };
  const db = {
    user: { findUniqueOrThrow: jest.fn().mockResolvedValue(row) },
    $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)),
  };
  const storage = {
    keyFor: jest.fn((...parts: string[]) => ['o1', ...parts].join('/')),
    put: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    presignedGetUrl: jest.fn().mockResolvedValue('https://storage.test/avatar'),
  };
  const audit = { log: jest.fn() };
  const service = new ProfileService(
    { db } as unknown as PrismaService,
    storage as unknown as StorageService,
    audit as unknown as AuditService,
    { get: () => 'u1' } as unknown as ClsService<RequestContext>,
  );
  return { service, tx, storage, audit };
}

const file = (content: Buffer, filename: string, truncated = false) => ({
  stream: Readable.from([content]),
  truncated: () => truncated,
  filename,
});

describe('ProfileService (D-146)', () => {
  it('should write and audit only what changed, and nothing when nothing did', async () => {
    const same = setup();
    await same.service.update({ uiLanguage: 'AR' });
    expect(same.tx.user.update).not.toHaveBeenCalled();
    const changed = setup();
    await expect(
      changed.service.update({ uiLanguage: 'EN', digitStyle: 'WESTERN' }),
    ).resolves.toMatchObject({
      uiLanguage: 'EN',
    });
    expect(changed.audit.log).toHaveBeenCalledWith(
      changed.tx,
      expect.objectContaining({ oldValues: { uiLanguage: 'AR' }, newValues: { uiLanguage: 'EN' } }),
    );
  });

  it('should store a small PNG or JPEG under the office prefix and delete the old one after the commit', async () => {
    const { service, storage } = setup({ avatarUrl: 'o1/users/u1/avatar-old.png' });
    const profile = await service.setAvatar(
      file(Buffer.concat([pngHeader(256, 256), Buffer.alloc(50)]), 'me.png'),
    );
    expect(storage.put).toHaveBeenCalledWith(
      expect.stringMatching(/^o1\/users\/u1\/avatar-[0-9a-f-]+\.png$/),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'image/png' }),
    );
    expect(storage.delete).toHaveBeenCalledWith('o1/users/u1/avatar-old.png');
    expect(profile.avatar).toEqual({ url: 'https://storage.test/avatar', expiresIn: 900 });
    await expect(
      setup().service.setAvatar(
        file(Buffer.concat([jpegHeader(300, 300), Buffer.alloc(50)]), 'me.jpg'),
      ),
    ).resolves.toBeDefined();
  });

  it('should refuse too heavy, wrong type, too large and truncated avatars', async () => {
    const { service } = setup();
    await expect(
      service.setAvatar(file(Buffer.alloc(2 * 1024 * 1024 + 1), 'big.png')),
    ).rejects.toMatchObject({
      code: 'VAL-006',
    });
    await expect(service.setAvatar(file(Buffer.from('%PDF-1.7'), 'x.pdf'))).rejects.toMatchObject({
      code: 'VAL-005',
    });
    await expect(
      service.setAvatar(file(Buffer.concat([pngHeader(4096, 4096), Buffer.alloc(50)]), 'huge.png')),
    ).rejects.toMatchObject({ code: 'VAL-001' });
    await expect(
      service.setAvatar(
        file(Buffer.concat([pngHeader(64, 64), Buffer.alloc(50)]), 'cut.png', true),
      ),
    ).rejects.toMatchObject({ code: 'VAL-006' });
  });

  it('should remove an avatar, and do nothing when there is none', async () => {
    const none = setup();
    await none.service.removeAvatar();
    expect(none.tx.user.update).not.toHaveBeenCalled();
    const some = setup({ avatarUrl: 'o1/users/u1/avatar-a.png' });
    await expect(some.service.removeAvatar()).resolves.toMatchObject({ avatar: null });
    expect(some.storage.delete).toHaveBeenCalledWith('o1/users/u1/avatar-a.png');
  });

  it('should list every category, change only what is sent and ignore an email switch without an email', async () => {
    const { service, tx } = setup({ notificationPrefs: { TASKS: { inApp: false } } });
    expect(await service.preferences()).toContainEqual({
      category: 'TASKS',
      inApp: false,
      email: null,
    });
    const next = await service.updatePreferences({
      TEAM: { email: false, inApp: false },
      HEARINGS: { email: false },
    });
    expect(next).toContainEqual({ category: 'TEAM', inApp: false, email: null });
    expect(next).toContainEqual({ category: 'HEARINGS', inApp: true, email: false });
    expect(next).toContainEqual({ category: 'TASKS', inApp: false, email: null });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        notificationPrefs: {
          TASKS: { inApp: false },
          TEAM: { inApp: false },
          HEARINGS: { email: false },
        },
      },
    });
  });
});

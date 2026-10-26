import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import type {
  NotificationPreferences,
  Profile,
  UpdateNotificationPreferencesRequest,
  UpdateProfileRequest,
} from '@nexlegtiq/shared-contracts';
import { EMAIL_CATEGORIES, NOTIFICATION_CATEGORIES } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../../common/audit/audit.service';
import { changes } from '../../common/audit/changes';
import type { RequestContext } from '../../common/context/request-context';
import { AppException, ValidationException } from '../../common/errors/app.exception';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
import { imageInfo } from '../documents/extraction/image-limits';
import { sniffFileType } from '../documents/upload/file-type';
import { NotificationPrefsSchema } from '../notifications/notification-preferences';

/** Avatars (D-146): PNG or JPEG, at most 2 MB and 4 MP — the app resizes to 256 px before sending. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MAX_PIXELS = 2048 * 2048;
const AVATAR_TYPES: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const PROFILE_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  phone: true,
  uiLanguage: true,
  timezone: true,
  digitStyle: true,
  avatarUrl: true,
  notificationPrefs: true,
} as const;

/**
 * The caller's own profile and preferences (D-146): no permission is needed — it is their own account (as the password
 * change, D-086). Every change is audited with its old and new values; the avatar lives in private storage under the
 * office's prefix, its key in `users.avatar_url`, and is shown through a short-lived link.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async get(): Promise<Profile> {
    return this.present(await this.load());
  }

  async update(body: UpdateProfileRequest): Promise<Profile> {
    const before = await this.load();
    const { old, next } = changes(before, body);
    if (Object.keys(next).length === 0) return this.present(before);
    const after = await this.prisma.db.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: before.id },
        data: next,
        select: PROFILE_SELECT,
      });
      await this.audit.log(tx, {
        action: 'UPDATE',
        entityType: 'User',
        entityId: before.id,
        oldValues: old,
        newValues: next,
      });
      return user;
    });
    return this.present(after);
  }

  /** A new avatar replaces the old one (whose object is deleted once the new key is saved). */
  async setAvatar(file: {
    stream: Readable;
    truncated: () => boolean;
    filename: string;
  }): Promise<Profile> {
    const content = await collect(file.stream, AVATAR_MAX_BYTES);
    if (!content || file.truncated()) throw new AppException('VAL-006', 'Avatar larger than 2 MB');
    const type = sniffFileType(content.subarray(0, 64 * 1024), file.filename)?.mimeType;
    const extension = type ? AVATAR_TYPES[type] : undefined;
    if (!type || !extension)
      throw new AppException('VAL-005', 'Avatar must be a PNG or JPEG image');
    const pixels = imageInfo(content, type)?.pixels;
    if (!pixels || pixels > AVATAR_MAX_PIXELS) {
      throw new ValidationException([{ field: 'file', message: 'validation.avatarSize' }]);
    }
    const before = await this.load();
    const key = this.storage.keyFor('users', before.id, `avatar-${randomUUID()}.${extension}`);
    await this.storage.put(key, content, { contentType: type, contentLength: content.length });
    const after = await this.saveAvatar(before.id, before.avatarUrl, key);
    return this.present(after);
  }

  async removeAvatar(): Promise<Profile> {
    const before = await this.load();
    if (!before.avatarUrl) return this.present(before);
    return this.present(await this.saveAvatar(before.id, before.avatarUrl, null));
  }

  async preferences(): Promise<NotificationPreferences> {
    return toPreferences((await this.load()).notificationPrefs);
  }

  /** Turns channels on or off; only what is sent changes, an email switch is ignored where there is no email. */
  async updatePreferences(
    body: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferences> {
    const before = await this.load();
    const current = NotificationPrefsSchema.parse(before.notificationPrefs);
    const next: Record<string, { email?: boolean; inApp?: boolean }> = { ...current };
    for (const [category, channels] of Object.entries(body)) {
      const emailAllowed = (EMAIL_CATEGORIES as readonly string[]).includes(category);
      const { email, inApp } = channels ?? {};
      next[category] = {
        ...next[category],
        ...(inApp !== undefined ? { inApp } : {}),
        ...(email !== undefined && emailAllowed ? { email } : {}),
      };
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: before.id }, data: { notificationPrefs: next } });
      await this.audit.log(tx, {
        action: 'UPDATE',
        entityType: 'User',
        entityId: before.id,
        oldValues: { notificationPrefs: current },
        newValues: { notificationPrefs: next },
      });
    });
    return toPreferences(next);
  }

  private async saveAvatar(userId: string, old: string | null, key: string | null) {
    const after = await this.prisma.db.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { avatarUrl: key },
        select: PROFILE_SELECT,
      });
      await this.audit.log(tx, {
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        oldValues: { avatar: old !== null },
        newValues: { avatar: key !== null },
      });
      return user;
    });
    // After the commit: a failed delete leaves an orphan object, never a profile without its picture.
    if (old) await this.storage.delete(old).catch(() => undefined);
    return after;
  }

  private async load() {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return this.prisma.db.user.findUniqueOrThrow({ where: { id: userId }, select: PROFILE_SELECT });
  }

  private async present(user: Awaited<ReturnType<ProfileService['load']>>): Promise<Profile> {
    const { avatarUrl, notificationPrefs: _prefs, ...rest } = user;
    const avatar = avatarUrl
      ? { url: await this.storage.presignedGetUrl(avatarUrl, { expiresIn: 900 }), expiresIn: 900 }
      : null;
    return { ...rest, avatar };
  }
}

/** Every category with its channels, on unless turned off; `email` null where the category sends none. */
function toPreferences(stored: unknown): NotificationPreferences {
  const prefs = NotificationPrefsSchema.parse(stored);
  return NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    inApp: prefs[category]?.inApp !== false,
    email: EMAIL_CATEGORIES.includes(category) ? prefs[category]?.email !== false : null,
  }));
}

/** The whole stream, or null once it passes `max` bytes (the rest is drained, not kept). */
async function collect(stream: Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  return size > max ? null : Buffer.concat(chunks);
}

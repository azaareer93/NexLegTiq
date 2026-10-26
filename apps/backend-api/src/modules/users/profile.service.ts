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
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../../common/audit/audit.service';
import { changes } from '../../common/audit/changes';
import type { RequestContext } from '../../common/context/request-context';
import { AppException, ValidationException } from '../../common/errors/app.exception';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { imageInfo } from '../documents/extraction/image-limits';
import { sniffFileType } from '../documents/upload/file-type';
import { readPrefs } from '../notifications/notification-preferences';
import type { NotificationPrefs } from '../notifications/notification-preferences';

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
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProfileService.name);
  }

  async get(): Promise<Profile> {
    return this.present(await this.load());
  }

  async update(body: UpdateProfileRequest): Promise<Profile> {
    const after = await this.prisma.db.$transaction(async (tx) => {
      const before = await this.lockMe(tx);
      const { old, next } = changes(before, body);
      if (Object.keys(next).length === 0) return before;
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
    const { type, extension } = avatarType(content, file.filename);
    const key = this.storage.keyFor('users', this.userId(), `avatar-${randomUUID()}.${extension}`);
    await this.storage.put(key, content, { contentType: type, contentLength: content.length });
    try {
      return this.present(await this.saveAvatar(key));
    } catch (error) {
      // Nothing points at the new object: remove it rather than leave an orphan.
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
  }

  async removeAvatar(): Promise<Profile> {
    return this.present(await this.saveAvatar(null));
  }

  async preferences(): Promise<NotificationPreferences> {
    return toPreferences((await this.load()).notificationPrefs);
  }

  /** Turns channels on or off; only what is sent changes, an email switch is ignored where there is no email. */
  async updatePreferences(
    body: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferences> {
    const saved = await this.prisma.db.$transaction(async (tx) => {
      const before = await this.lockMe(tx);
      const current = readPrefs(before.notificationPrefs);
      const next = mergePrefs(current, body);
      // A change that changes nothing writes nothing (D-136).
      if (JSON.stringify(toPreferences(next)) === JSON.stringify(toPreferences(current)))
        return next;
      await tx.user.update({ where: { id: before.id }, data: { notificationPrefs: next } });
      await this.audit.log(tx, {
        action: 'UPDATE',
        entityType: 'User',
        entityId: before.id,
        oldValues: { notificationPrefs: current },
        newValues: { notificationPrefs: next },
      });
      return next;
    });
    return toPreferences(saved);
  }

  /** Sets (or clears) the avatar key under the row lock, so two uploads at once never lose track of an object. */
  private async saveAvatar(key: string | null) {
    const { user, old } = await this.prisma.db.$transaction(async (tx) => {
      const before = await this.lockMe(tx);
      if (before.avatarUrl === key) return { user: before, old: null };
      const after = await tx.user.update({
        where: { id: before.id },
        data: { avatarUrl: key },
        select: PROFILE_SELECT,
      });
      await this.audit.log(tx, {
        action: 'UPDATE',
        entityType: 'User',
        entityId: before.id,
        oldValues: { avatar: before.avatarUrl !== null },
        newValues: { avatar: key !== null },
      });
      return { user: after, old: before.avatarUrl };
    });
    // After the commit: a failed delete leaves an orphan object, never a profile without its picture.
    if (old) await this.storage.delete(old).catch(() => undefined);
    return user;
  }

  private userId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }

  private load() {
    return this.prisma.db.user.findUniqueOrThrow({
      where: { id: this.userId() },
      select: PROFILE_SELECT,
    });
  }

  /** The caller's row, locked until the transaction ends: concurrent edits queue and audit the right old values. */
  private async lockMe(tx: ScopedTransaction) {
    const id = this.userId();
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${id}::uuid AND office_id = ${this.cls.get('officeId')}::uuid FOR UPDATE`;
    return tx.user.findUniqueOrThrow({ where: { id }, select: PROFILE_SELECT });
  }

  private async present(user: Awaited<ReturnType<ProfileService['load']>>): Promise<Profile> {
    const { avatarUrl, notificationPrefs: _prefs, ...rest } = user;
    return { ...rest, avatar: avatarUrl ? await this.avatarLink(avatarUrl) : null };
  }

  /** A link to the picture; a key that cannot be served is logged and shown as no picture, never a failed profile. */
  private async avatarLink(key: string): Promise<Profile['avatar']> {
    try {
      return { url: await this.storage.presignedGetUrl(key, { expiresIn: 900 }), expiresIn: 900 };
    } catch (error) {
      this.logger.warn(
        { userId: this.userId(), error: error instanceof Error ? error.name : typeof error },
        'avatar link unavailable',
      );
      return null;
    }
  }
}

/** PNG or JPEG judged by its bytes, at most 4 megapixels (2048 × 2048), else the matching refusal. */
function avatarType(content: Buffer, filename: string): { type: string; extension: string } {
  const type = sniffFileType(content.subarray(0, 64 * 1024), filename)?.mimeType;
  const extension = type ? AVATAR_TYPES[type] : undefined;
  if (!type || !extension) throw new AppException('VAL-005', 'Avatar must be a PNG or JPEG image');
  const pixels = imageInfo(content, type)?.pixels;
  if (!pixels || pixels > AVATAR_MAX_PIXELS) {
    throw new ValidationException([{ field: 'file', message: 'validation.avatarSize' }]);
  }
  return { type, extension };
}

/** The stored choices with the request's switches applied; `email` only where the category sends one. */
function mergePrefs(
  current: NotificationPrefs,
  body: UpdateNotificationPreferencesRequest,
): NotificationPrefs {
  const next: NotificationPrefs = { ...current };
  for (const category of NOTIFICATION_CATEGORIES) {
    const channels = body[category];
    if (!channels) continue;
    const emailAllowed = EMAIL_CATEGORIES.includes(category);
    next[category] = {
      ...next[category],
      ...(channels.inApp !== undefined ? { inApp: channels.inApp } : {}),
      ...(channels.email !== undefined && emailAllowed ? { email: channels.email } : {}),
    };
  }
  return next;
}

/** Every category with its channels, on unless turned off; `email` null where the category sends none. */
function toPreferences(stored: unknown): NotificationPreferences {
  const prefs = readPrefs(stored);
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

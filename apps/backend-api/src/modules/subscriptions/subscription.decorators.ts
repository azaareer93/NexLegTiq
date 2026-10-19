import { SetMetadata } from '@nestjs/common';
import type { PlanFeature } from '@nexlegtiq/shared-contracts';

export const FEATURE_KEY = 'nexlegtiq:plan-feature';
export const ALLOW_READ_ONLY_KEY = 'nexlegtiq:allow-when-read-only';

/** The office's plan must include the feature, else 403 AUTH-102 (D-122). Checked by `SubscriptionGuard`. */
export const RequireFeature = (feature: PlanFeature): MethodDecorator & ClassDecorator =>
  SetMetadata(FEATURE_KEY, feature);

/**
 * A write that stays allowed while the office is read-only (D-122): the caller's own account (password), never office
 * data.
 */
export const AllowWhenReadOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_READ_ONLY_KEY, true);

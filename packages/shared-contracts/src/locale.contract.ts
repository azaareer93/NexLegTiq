import { SUPPORTED_LOCALES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

export const LocaleSchema = z.enum(SUPPORTED_LOCALES);

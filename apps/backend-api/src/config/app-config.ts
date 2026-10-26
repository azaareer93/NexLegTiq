import type { Env } from './env.schema';

/** Typed, validated configuration. Inject this instead of reading `process.env`. */
export class AppConfig {
  // ES private field: invisible to JSON.stringify and util.inspect, so logging the config never prints secrets.
  readonly #env: Env;

  constructor(env: Env) {
    this.#env = env;
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.#env.NODE_ENV;
  }

  get isProduction(): boolean {
    return this.#env.NODE_ENV === 'production';
  }

  get http(): {
    readonly host: string;
    readonly port: number;
    readonly trustProxyHops: number;
  } {
    return {
      host: this.#env.HOST,
      port: this.#env.PORT,
      trustProxyHops: this.#env.TRUST_PROXY_HOPS,
    };
  }

  get log(): { readonly level: Env['LOG_LEVEL']; readonly pretty: boolean } {
    return { level: this.#env.LOG_LEVEL, pretty: this.#env.LOG_PRETTY };
  }

  get corsOrigins(): readonly string[] {
    return this.#env.CORS_ORIGINS;
  }

  get swaggerEnabled(): boolean {
    return this.#env.SWAGGER_ENABLED;
  }

  get metrics(): {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
  } {
    return {
      enabled: this.#env.METRICS_ENABLED,
      host: this.#env.METRICS_HOST,
      port: this.#env.METRICS_PORT,
    };
  }

  get database(): { readonly url: string } {
    return { url: this.#env.DATABASE_URL };
  }

  get bullBoardEnabled(): boolean {
    return this.#env.BULL_BOARD_ENABLED;
  }

  get redis(): { readonly url: string; readonly bullmqPrefix: string } {
    return { url: this.#env.REDIS_URL, bullmqPrefix: this.#env.BULLMQ_PREFIX };
  }

  get storage(): {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
    readonly sse: 'AES256' | 'none';
  } {
    return {
      endpoint: this.#env.S3_ENDPOINT,
      region: this.#env.S3_REGION,
      bucket: this.#env.S3_BUCKET,
      accessKeyId: this.#env.S3_ACCESS_KEY_ID,
      secretAccessKey: this.#env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: this.#env.S3_FORCE_PATH_STYLE,
      sse: this.#env.S3_SSE,
    };
  }

  get mail(): {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly requireTLS: boolean;
    readonly auth?: { readonly user: string; readonly pass: string };
    readonly from: string;
    readonly provider: 'smtp' | 'resend';
    readonly resendApiKey?: string;
    readonly officeAppUrl: string;
  } {
    const { SMTP_USER: user, SMTP_PASSWORD: pass } = this.#env;
    return {
      host: this.#env.SMTP_HOST,
      port: this.#env.SMTP_PORT,
      secure: this.#env.SMTP_SECURE,
      requireTLS: this.#env.SMTP_REQUIRE_TLS,
      ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
      from: this.#env.MAIL_FROM,
      provider: this.#env.EMAIL_PROVIDER,
      ...(this.#env.RESEND_API_KEY ? { resendApiKey: this.#env.RESEND_API_KEY } : {}),
      // Without a trailing slash, so templates can append paths.
      officeAppUrl: this.#env.OFFICE_APP_URL.replace(/\/+$/, ''),
    };
  }

  get auth(): { readonly jwtSecret: string; readonly emailVerificationEnforced: boolean } {
    return {
      jwtSecret: this.#env.JWT_SECRET,
      emailVerificationEnforced: this.#env.EMAIL_VERIFICATION_ENFORCED,
    };
  }

  /** The platform admin realm (D-145); null when `ADMIN_JWT_SECRET` is unset (its routes answer 404). */
  get admin(): {
    readonly jwtSecret: string;
    readonly ipAllowlist: readonly string[];
    readonly origins: readonly string[];
  } | null {
    const env = this.#env;
    return env.ADMIN_JWT_SECRET
      ? {
          jwtSecret: env.ADMIN_JWT_SECRET,
          ipAllowlist: env.ADMIN_IP_ALLOWLIST,
          origins: env.ADMIN_ORIGINS,
        }
      : null;
  }

  /** Key of the field cipher (D-056), 32 bytes as hex. */
  get encryptionKey(): string {
    return this.#env.ENCRYPTION_KEY;
  }

  get ocr(): {
    readonly concurrency?: number;
    readonly timeoutMs?: number;
    readonly maxPages: number;
    readonly autoSummary: boolean;
  } {
    const env = this.#env;
    return {
      ...(env.OCR_WORKER_CONCURRENCY ? { concurrency: env.OCR_WORKER_CONCURRENCY } : {}),
      ...(env.OCR_JOB_TIMEOUT_MS ? { timeoutMs: env.OCR_JOB_TIMEOUT_MS } : {}),
      maxPages: env.OCR_MAX_PAGES,
      autoSummary: env.AI_AUTO_SUMMARY,
    };
  }

  get clamav(): { readonly host: string; readonly port: number } {
    return { host: this.#env.CLAMAV_HOST, port: this.#env.CLAMAV_PORT };
  }

  get ai(): AiConfig {
    const env = this.#env;
    return {
      primary: env.AI_PRIMARY_PROVIDER,
      fallback: env.AI_FALLBACK_PROVIDER,
      openai:
        env.OPENAI_API_KEY && env.OPENAI_MODEL
          ? { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }
          : undefined,
      gemini:
        env.GEMINI_API_KEY && env.GEMINI_MODEL
          ? { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }
          : undefined,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      temperature: env.AI_TEMPERATURE,
      timeoutMs: env.AI_TIMEOUT_MS,
      cacheTtlSeconds: env.AI_CACHE_TTL,
      prices: env.AI_MODEL_PRICES,
    };
  }
}

export type AiProviderName = Env['AI_PRIMARY_PROVIDER'];

export interface AiConfig {
  readonly primary: AiProviderName;
  readonly fallback: AiProviderName;
  readonly openai?: { readonly apiKey: string; readonly model: string };
  readonly gemini?: { readonly apiKey: string; readonly model: string };
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly timeoutMs: number;
  readonly cacheTtlSeconds: number;
  readonly prices: Readonly<Record<string, { readonly input: number; readonly output: number }>>;
}

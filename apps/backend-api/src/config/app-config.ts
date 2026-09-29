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
  } {
    return {
      endpoint: this.#env.S3_ENDPOINT,
      region: this.#env.S3_REGION,
      bucket: this.#env.S3_BUCKET,
      accessKeyId: this.#env.S3_ACCESS_KEY_ID,
      secretAccessKey: this.#env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: this.#env.S3_FORCE_PATH_STYLE,
    };
  }

  get mail(): {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly requireTLS: boolean;
    readonly auth?: { readonly user: string; readonly pass: string };
    readonly from: string;
  } {
    const { SMTP_USER: user, SMTP_PASSWORD: pass } = this.#env;
    return {
      host: this.#env.SMTP_HOST,
      port: this.#env.SMTP_PORT,
      secure: this.#env.SMTP_SECURE,
      requireTLS: this.#env.SMTP_REQUIRE_TLS,
      ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
      from: this.#env.MAIL_FROM,
    };
  }

  get clamav(): { readonly host: string; readonly port: number } {
    return { host: this.#env.CLAMAV_HOST, port: this.#env.CLAMAV_PORT };
  }
}

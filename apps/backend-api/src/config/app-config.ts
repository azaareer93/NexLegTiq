import type { Env } from './env.schema';

/** Typed, validated configuration. Inject this instead of reading `process.env`. */
export class AppConfig {
  constructor(private readonly env: Env) {}

  get nodeEnv(): Env['NODE_ENV'] {
    return this.env.NODE_ENV;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get http(): { readonly host: string; readonly port: number; readonly trustProxyHops: number } {
    return { host: this.env.HOST, port: this.env.PORT, trustProxyHops: this.env.TRUST_PROXY_HOPS };
  }

  get log(): { readonly level: Env['LOG_LEVEL']; readonly pretty: boolean } {
    return { level: this.env.LOG_LEVEL, pretty: this.env.LOG_PRETTY };
  }

  get corsOrigins(): readonly string[] {
    return this.env.CORS_ORIGINS;
  }

  get swaggerEnabled(): boolean {
    return this.env.SWAGGER_ENABLED;
  }

  get metrics(): { readonly enabled: boolean; readonly host: string; readonly port: number } {
    return { enabled: this.env.METRICS_ENABLED, host: this.env.METRICS_HOST, port: this.env.METRICS_PORT };
  }
}

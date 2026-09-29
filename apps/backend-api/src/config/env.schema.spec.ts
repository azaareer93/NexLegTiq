import { AppConfig } from './app-config';
import { parseEnv } from './env.schema';

describe('parseEnv', () => {
  it('should apply fail-closed defaults when the environment is empty', () => {
    const env = parseEnv({});

    expect(env).toMatchObject({
      NODE_ENV: 'production',
      HOST: 'localhost',
      PORT: 3000,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      SWAGGER_ENABLED: false,
      METRICS_ENABLED: true,
      METRICS_PORT: 9464,
      TRUST_PROXY_HOPS: 0,
    });
    expect(env.CORS_ORIGINS).toEqual([
      'http://localhost:4200',
      'http://localhost:4201',
      'http://localhost:4202',
    ]);
  });

  it('should coerce numbers, booleans and comma-separated origins', () => {
    const env = parseEnv({
      NODE_ENV: 'development',
      PORT: '8080',
      LOG_PRETTY: 'true',
      METRICS_ENABLED: 'false',
      CORS_ORIGINS: 'https://app.example.test, https://portal.example.test',
    });

    expect(env.PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.METRICS_ENABLED).toBe(false);
    expect(env.CORS_ORIGINS).toEqual(['https://app.example.test', 'https://portal.example.test']);
  });

  it('should normalise CORS origins to scheme://host[:port]', () => {
    const env = parseEnv({ CORS_ORIGINS: 'https://app.example.test/, http://localhost:4200/path' });

    expect(env.CORS_ORIGINS).toEqual(['https://app.example.test', 'http://localhost:4200']);
  });

  it('should reject LOG_PRETTY in production but allow it elsewhere', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', LOG_PRETTY: 'true' })).toThrow(/LOG_PRETTY/);
    expect(parseEnv({ NODE_ENV: 'development', LOG_PRETTY: 'true' }).LOG_PRETTY).toBe(true);
  });

  it('should enable Swagger by default outside production', () => {
    expect(parseEnv({ NODE_ENV: 'development' }).SWAGGER_ENABLED).toBe(true);
    expect(parseEnv({ NODE_ENV: 'test' }).SWAGGER_ENABLED).toBe(true);
  });

  it('should disable Swagger by default in production but honour an explicit flag', () => {
    expect(parseEnv({ NODE_ENV: 'production' }).SWAGGER_ENABLED).toBe(false);
    expect(parseEnv({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED).toBe(true);
  });

  it('should ignore unknown variables', () => {
    expect(parseEnv({ SOMETHING_ELSE: 'x' })).not.toHaveProperty('SOMETHING_ELSE');
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['CORS_ORIGINS', 'not-a-url'],
    ['METRICS_ENABLED', 'maybe'],
    ['TRUST_PROXY_HOPS', '-1'],
  ])('should throw naming %s when it is %s', (key, value) => {
    expect(() => parseEnv({ [key]: value })).toThrow(new RegExp(`Invalid environment:[\\s\\S]*${key}`));
  });
});

describe('AppConfig', () => {
  it('should expose grouped, typed settings', () => {
    const config = new AppConfig(parseEnv({ NODE_ENV: 'production', HOST: '0.0.0.0', METRICS_PORT: '9100' }));

    expect(config.isProduction).toBe(true);
    expect(config.nodeEnv).toBe('production');
    expect(config.http).toEqual({ host: '0.0.0.0', port: 3000, trustProxyHops: 0 });
    expect(config.log).toEqual({ level: 'info', pretty: false });
    expect(config.swaggerEnabled).toBe(false);
    expect(config.corsOrigins).toHaveLength(3);
    expect(config.metrics).toEqual({ enabled: true, host: 'localhost', port: 9100 });
  });
});

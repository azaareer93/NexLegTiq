/**
 * Backend-only lint rules (CLAUDE.md non-negotiables 1 and 9, D-058, D-080), spread into apps/backend-api/eslint.config.mjs.
 * Each one has fixtures in `src/backend-rules.spec.ts` proving it triggers.
 */

/**
 * `prisma.unscoped()` bypasses tenant isolation (D-018/D-080). Allowed only for migrations, seeds, signup/login before an
 * office is known, and platform-admin code, and every call must say why in a comment directly above it (or on the same
 * line): `// unscoped: <reason>`. Reviewers grep for `unscoped:`.
 */
const unscopedNeedsReason = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missing:
        'prisma.unscoped() bypasses tenant isolation: add `// unscoped: <reason>` directly above this call.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    const check = (node) => {
      const line = node.loc.start.line;
      const justified = source
        .getAllComments()
        .some(
          (comment) =>
            (comment.loc.end.line === line - 1 || comment.loc.start.line === line) &&
            /unscoped:\s*\S/.test(comment.value),
        );
      if (!justified) context.report({ node, messageId: 'missing' });
    };
    // Any access, not only a direct call: `x.unscoped()`, `x['unscoped']`, `x.unscoped.call(x)`, `const { unscoped } = x`.
    return {
      "MemberExpression[computed=false][property.name='unscoped']": check,
      "MemberExpression[computed=true][property.value='unscoped']": check,
      "ObjectPattern > Property[key.name='unscoped']": check,
    };
  },
};

/** Redis / cache commands whose first argument is a key. */
const KEY_COMMANDS = new Set([
  'get',
  'set',
  'setex',
  'psetex',
  'getdel',
  'del',
  'unlink',
  'exists',
  'expire',
  'pexpire',
  'ttl',
  'incr',
  'incrby',
  'decr',
  'decrby',
  'hget',
  'hset',
  'hdel',
  'hgetall',
  'hincrby',
  'sadd',
  'srem',
  'smembers',
  'sismember',
  'zadd',
  'zrem',
  'zrange',
  'lpush',
  'rpush',
  'lrange',
  'mget',
  'mset',
  'wrap',
]);
const CACHE_CLIENT = /redis|cache/i;

const isTextKey = (node) =>
  (node.type === 'Literal' && typeof node.value === 'string') ||
  node.type === 'TemplateLiteral' ||
  (node.type === 'BinaryExpression' && node.operator === '+');

/**
 * Tenant cache keys must start with `o:{officeId}:` (D-058), so they are built only by `CacheKeys` (common/tenancy/tenant-keys.ts):
 * a string or template literal passed as the key to a Redis/cache client (`redis.get('cases:…')`, `this.cache.set(\`…\`)`) is an
 * error. A heuristic: the receiver's name must contain "redis" or "cache".
 */
const noRawCacheKey = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      raw: 'Build cache keys with CacheKeys.tenant(officeId, …) (D-058), not a string: other offices could read the entry.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          !KEY_COMMANDS.has(callee.property.name)
        )
          return;
        const receiver = context.sourceCode.getText(callee.object);
        const [key] = node.arguments;
        if (CACHE_CLIENT.test(receiver) && key && isTextKey(key))
          context.report({ node: key, messageId: 'raw' });
      },
    };
  },
};

export const nexlegtiqPlugin = {
  rules: { 'unscoped-needs-reason': unscopedNeedsReason, 'no-raw-cache-key': noRawCacheKey },
};

export const backendRules = [
  {
    files: ['**/*.ts'],
    plugins: { nexlegtiq: nexlegtiqPlugin },
    rules: {
      // error, not warn: the `// unscoped: <reason>` comment is how a call is allowed.
      'nexlegtiq/unscoped-needs-reason': 'error',
      'nexlegtiq/no-raw-cache-key': 'error',
      // String-built SQL is never allowed (CLAUDE.md non-negotiable 9); tagged $queryRaw/$executeRaw only.
      'no-restricted-properties': [
        'error',
        {
          property: '$queryRawUnsafe',
          message:
            'Use the tagged $queryRaw template (parameterised); tenant tables need officeId as a parameter.',
        },
        {
          property: '$executeRawUnsafe',
          message:
            'Use the tagged $executeRaw template (parameterised); tenant tables need officeId as a parameter.',
        },
      ],
    },
  },
  // Tests set up fixtures across offices on purpose; the key helper itself builds the strings.
  { files: ['**/*.spec.ts'], rules: { 'nexlegtiq/unscoped-needs-reason': 'off' } },
  { files: ['**/tenancy/tenant-keys.ts'], rules: { 'nexlegtiq/no-raw-cache-key': 'off' } },
];

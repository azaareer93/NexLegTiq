/**
 * Backend-only lint rules (CLAUDE.md non-negotiables 1 and 9, D-058, D-080), spread into apps/backend-api/eslint.config.mjs.
 * Each one has fixtures in `packages/shared-config/src/lint-rules.spec.ts` proving it triggers.
 */

/**
 * `prisma.unscoped()` bypasses tenant isolation (D-018/D-080). Allowed only for migrations, seeds, signup/login before an
 * office is known, and platform-admin code, and every call must say why in a comment directly above it (or on the same
 * line): `// unscoped: <reason>`. Reviewers grep for `unscoped:`.
 */
/** The property name of `x.name`, `x['name']` or ``x[`name`]``; null for a key computed at run time (`x[k]`). */
function staticName(member) {
  const { property } = member;
  if (!member.computed) return property.type === 'Identifier' ? property.name : null;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0].value.cooked;
  return null;
}

/** The receiver is the Prisma service itself (`prisma`, `this.prisma`), where `unscoped` lives. */
const PRISMA_RECEIVER = /(^|\.)prisma$/i;

const unscopedNeedsReason = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missing:
        'prisma.unscoped() bypasses tenant isolation: add `// unscoped: <reason>` directly above this call.',
      dynamic:
        'A run-time property name on the Prisma service could reach unscoped(): use the property by name.',
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
    // Any access, not only a direct call: `x.unscoped()`, `x['unscoped']`, ``x[`unscoped`]``, `x.unscoped.call(x)`,
    // `const { unscoped } = x`; and `prisma[k]` with a run-time key, which could be 'unscoped'.
    return {
      MemberExpression(node) {
        const name = staticName(node);
        if (name === 'unscoped') check(node);
        else if (name === null && PRISMA_RECEIVER.test(source.getText(node.object))) {
          context.report({ node, messageId: 'dynamic' });
        }
      },
      "ObjectPattern > Property[key.name='unscoped']": check,
    };
  },
};

/** Redis / cache commands whose first argument is a key. */
const KEY_COMMANDS = new Set(
  (
    'get set setex psetex setnx getset getex getdel append del unlink exists expire pexpire expireat pexpireat ttl pttl ' +
    'persist incr incrby decr decrby hget hset hmget hmset hexists hdel hgetall hincrby sadd srem smembers sismember scard ' +
    'zadd zrem zrange zrangebyscore zscore zincrby lpush rpush lpop rpop llen lrange mget mset keys wrap'
  ).split(' '),
);
/** Commands whose every argument is a key. */
const ALL_KEYS = new Set(['del', 'unlink', 'exists', 'mget']);
const CACHE_CLIENT = /redis|cache/i;

const isTextKey = (node) =>
  (node.type === 'Literal' && typeof node.value === 'string') ||
  node.type === 'TemplateLiteral' ||
  (node.type === 'BinaryExpression' && node.operator === '+');

/**
 * Tenant cache keys must start with `o:{officeId}:` (D-058), so they are built only by `CacheKeys` (common/tenancy/tenant-keys.ts):
 * a string, template or concatenated key passed to a Redis/cache client (`redis.get('cases:…')`, `this.cache['set'](\`…\`)`) is
 * an error. A heuristic: the receiver's name must contain "redis" or "cache", and a key held in a variable is not seen.
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
        if (callee.type !== 'MemberExpression') return;
        const command = staticName(callee);
        if (
          !KEY_COMMANDS.has(command) ||
          !CACHE_CLIENT.test(context.sourceCode.getText(callee.object))
        )
          return;
        const keys = ALL_KEYS.has(command) ? node.arguments : node.arguments.slice(0, 1);
        for (const key of keys.filter(isTextKey)) context.report({ node: key, messageId: 'raw' });
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

export const planKeys = {
  all: ['admin-plans'] as const,
  list: () => [...planKeys.all, 'list'] as const,
};

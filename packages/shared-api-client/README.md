# @nexlegtiq/shared-api-client

Typed HTTP client for the SPAs (D-089). May depend on `shared-types`, `shared-utils` and `shared-contracts`.

```ts
const client = createApiClient({
  baseURL: import.meta.env.VITE_API_URL,
  realm: 'office',
  getToken: () => useSession.getState().accessToken, // memory only (D-050)
  setToken: (token) => useSession.setState({ accessToken: token }),
  onAuthFailure: () => { useSession.getState().clear(); queryClient.clear(); router.navigate('/login'); },
});
const auth = authApi(client);
await auth.login({ email, password });
const thing = await client.request({ method: 'GET', path: `things/${id}`, signal }, ThingResponseSchema);
```

- Failures reject with `ApiError` (`code` → `t('errors.<CODE>')`, `details` → form fields, `requestId` for support).
- A 401 `AUTH-002` refreshes once (one refresh per tab, serialised across tabs) and retries once.
- `idempotencyHeaders(key)` for create endpoints that honour `Idempotency-Key`.

Source package (no build step): consumers import `src/index.ts` through the package `exports`.
Boundaries: `packages/shared-config/eslint/module-boundaries.mjs`. Test: `pnpm nx test shared-api-client`.

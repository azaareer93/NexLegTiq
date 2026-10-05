# @nexlegtiq/shared-api-client

Typed HTTP client for the SPAs (D-089). May depend on `shared-types`, `shared-utils` and `shared-contracts`.

```ts
const client = createApiClient({
  baseURL: import.meta.env.VITE_API_URL,
  realm: 'office',
  getToken: () => useSession.getState().accessToken, // memory only (D-050)
  setToken: (token) => useSession.setState({ accessToken: token }),
  // A session lost mid-use (refresh refused). Not called by the app-start restore, which just rejects.
  onAuthFailure: () => { useSession.getState().clear(); queryClient.clear(); router.navigate('/login'); },
});
const auth = authApi(client);
await auth.login({ email, password });
const thing = await client.request({ method: 'GET', path: `things/${id}`, signal }, ThingResponseSchema);
```

- Failures reject with `ApiError` (`code` → `t('errors.<CODE>')`, `details` → form fields, `requestId` for support).
- A 401 `AUTH-002` refreshes once (one refresh per tab, serialised across tabs) and retries once.
- Login, register and logout use `sessionRequest` (after any refresh, under the cross-tab lock); the returned session has no
  `accessToken` (it stays in the client).
- `idempotencyHeaders(key)` for create endpoints that honour `Idempotency-Key`: create the key once per user action.

Source package (no build step): consumers import `src/index.ts` through the package `exports`.
Boundaries: `packages/shared-config/eslint/module-boundaries.mjs`. Test: `pnpm nx test shared-api-client`.

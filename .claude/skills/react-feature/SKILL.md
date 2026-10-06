---
name: react-feature
description: Pattern for building a NexLegTiq frontend feature (office-app, client-portal, admin-panel) — folder layout, routes, React Query hooks on shared-api-client, AntD forms with shared Zod contracts, permissions, error mapping, i18n, and tests. Use when adding pages, components, or data hooks.
---
# React feature recipe

```
apps/office-app/src/features/cases/
  api/keys.ts            // query key factory
  api/use-cases.ts       // useCasesList, useCase, useCreateCase …
  components/CaseStatusTag/{CaseStatusTag.tsx, CaseStatusTag.test.tsx, index.ts}
  pages/CasesListPage.tsx, pages/CaseDetailsPage.tsx
  routes.tsx             // lazy routes + permission guard
  i18n/                  // (keys live in packages/shared-i18n/src/locales/{ar,en}/cases.json)
```

## Data hooks
```ts
export const caseKeys = {
  all: ['cases'] as const,
  list: (q: CaseQuery) => [...caseKeys.all, 'list', q] as const,
  detail: (id: FileId) => [...caseKeys.all, 'detail', id] as const,
};
export const useCasesList = (q: CaseQuery) =>
  useQuery({ queryKey: caseKeys.list(q), queryFn: () => api.cases.list(q), placeholderData: keepPreviousData });
export const useCreateCase = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.cases.create, onSuccess: () => qc.invalidateQueries({ queryKey: caseKeys.all }) });
};
```

## Forms
AntD `Form` + `zodRule(CreateCaseSchema.shape.title, translateKey)` adapter. Errors via `useApiErrorHandler()` (shared-ui, D-093):
`applyToForm(form, error, FIELDS)` puts VAL-001 `details` on fields and `<ApiErrorAlert error fields />` explains the rest; a
failed action without a form → `notify(error)`; a failed load → `<ErrorState code requestId onRetry />`; success → `message.success`.

## Pages
- List pages: filters in URL search params (`useSearchParams`), server pagination, empty/loading/error states (shared components).
- Detail pages: tabs in URL (`?tab=documents`), skeletons, 404 page on `RES-001`.
- Permissions: `const can = useCan(); can('create:case') && <Button …/>`.
- Realtime: subscribe via `useRealtime('document.processed', handler)` and invalidate the relevant query keys.

## Tests
Vitest + Testing Library + MSW handlers in `src/test/handlers`; `renderWithProviders(ui, { locale: 'ar' })` and `'en'`;
assert visible text via i18n keys' values; `jest-axe` on pages. Add `data-testid` for Cypress selectors.

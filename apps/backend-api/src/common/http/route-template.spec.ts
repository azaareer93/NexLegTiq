import { routeTemplateOf } from './route-template';
import type { RoutedRequest } from './route-template';

const req = (fields: { baseUrl?: string; route?: { path?: unknown } }): RoutedRequest =>
  fields as unknown as RoutedRequest;

describe('routeTemplateOf', () => {
  it('should join baseUrl and the matched route path', () => {
    expect(routeTemplateOf(req({ baseUrl: '/api/v1', route: { path: '/cases/:id' } }))).toBe(
      '/api/v1/cases/:id',
    );
    expect(routeTemplateOf(req({ route: { path: '/health' } }))).toBe('/health');
  });

  it("should treat Nest's not-found catch-all as unmatched", () => {
    expect(routeTemplateOf(req({ route: { path: '/api/v1{/*splat}' } }))).toBeUndefined();
  });

  it('should be undefined when no route matched', () => {
    expect(routeTemplateOf(req({}))).toBeUndefined();
    expect(routeTemplateOf(undefined)).toBeUndefined();
  });
});

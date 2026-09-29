import axios from 'axios';

// Smoke test of the built bundle (dist/main.js): real bootstrap, port binding and middleware as deployed.
// Behaviour details are covered in-process by apps/backend-api/src/app/*.spec.ts.
describe('backend-api (built server)', () => {
  it('should serve liveness and readiness with security headers', async () => {
    const live = await axios.get('/health');
    const ready = await axios.get('/health/ready');

    expect(live.data).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(ready.data).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(live.headers['x-content-type-options']).toBe('nosniff');
    expect(live.headers['x-powered-by']).toBeUndefined();
    expect(live.headers['x-request-id']).toBe(live.data.meta.requestId);
  });

  it('should answer 404 RES-001 in the error envelope for an unknown route under /api/v1', async () => {
    const res = await axios.get('/api/v1/__unknown__', { validateStatus: () => true });

    expect(res.status).toBe(404);
    expect(res.data).toMatchObject({ success: false, error: { code: 'RES-001' } });
  });
});

import axios from 'axios';

describe('HTTP API (running server)', () => {
  it('should answer 404 RES-001 in the error envelope for an unknown route under /api/v1', async () => {
    const res = await axios.get('/api/v1/__unknown__', { validateStatus: () => true });

    expect(res.status).toBe(404);
    expect(res.data).toMatchObject({
      success: false,
      error: { code: 'RES-001' },
      meta: { requestId: res.headers['x-request-id'] },
    });
  });

  it('should echo a caller-provided x-request-id', async () => {
    const res = await axios.get('/health', { headers: { 'x-request-id': 'e2e-request-0001' } });

    expect(res.headers['x-request-id']).toBe('e2e-request-0001');
    expect(res.data.meta.requestId).toBe('e2e-request-0001');
  });

  it('should report liveness and readiness outside the version prefix', async () => {
    const live = await axios.get('/health');
    const ready = await axios.get('/health/ready');

    expect(live.data).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(ready.data).toMatchObject({ success: true, data: { status: 'ok' } });
  });
});

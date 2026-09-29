import axios from 'axios';

describe('HTTP API', () => {
  it('should answer 404 for an unknown route under /api/v1 when the server is up', async () => {
    const res = await axios.get('/api/v1/__unknown__', { validateStatus: () => true });

    expect(res.status).toBe(404);
  });
});

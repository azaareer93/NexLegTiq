import type { AiJobs } from './ai-jobs';
import { AiJobsController } from './ai-jobs.controller';
import { AiUsageController } from './ai-usage.controller';
import { DashboardController } from '../dashboard/dashboard.controller';
import type { DashboardService } from '../dashboard/dashboard.service';

describe('thin AI and dashboard controllers', () => {
  it('should hand each call to its service', async () => {
    const jobs = { get: jest.fn().mockResolvedValue({ id: 'j1' }) };
    await expect(new AiJobsController(jobs as unknown as AiJobs).get('j1')).resolves.toEqual({
      id: 'j1',
    });
    const dashboard = { get: jest.fn().mockResolvedValue({ today: '2026-11-15' }) };
    await expect(
      new DashboardController(dashboard as unknown as DashboardService).get(),
    ).resolves.toEqual({ today: '2026-11-15' });
    expect(AiUsageController).toBeDefined();
  });
});

import { Test } from '@nestjs/testing';

import { WorkerModule } from './worker.module';
import { ReadinessRegistry } from '../health/readiness.registry';

describe('WorkerModule', () => {
  it('should compile as a standalone application context with a readiness registry', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    try {
      expect(moduleRef.get(WorkerModule)).toBeInstanceOf(WorkerModule);
      expect(moduleRef.get(ReadinessRegistry)).toBeInstanceOf(ReadinessRegistry);
    } finally {
      await moduleRef.close();
    }
  });
});

import { Test } from '@nestjs/testing';

import { AppModule } from './app.module';

describe('AppModule', () => {
  it('should compile the HTTP root module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    try {
      expect(moduleRef.get(AppModule)).toBeInstanceOf(AppModule);
    } finally {
      await moduleRef.close();
    }
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { VideoProcessor } from './videos/processing/video.processor';
import { VideosController } from './videos/videos.controller';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  }, 30000);

  afterAll(async () => {
    await module.close();
  });

  it('should compile with the video processor', () => {
    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
  });

  it('should not load any HTTP controller', () => {
    expect(() => module.get(VideosController, { strict: false })).toThrow();
  });
});

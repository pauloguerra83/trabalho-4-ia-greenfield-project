import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';

/** Video worker: no HTTP layer, no controllers, no guards. */
@Module({
  imports: [CoreModule, VideoProcessingModule],
})
export class WorkerModule {}

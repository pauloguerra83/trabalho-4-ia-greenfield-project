import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaModule } from '../../media/media.module';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { UsersModule } from '../../users/users.module';
import { Video } from '../entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

/** Queue consumer side of the videos domain; imported only by WorkerModule. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // Video → Channel → User relations: with autoLoadEntities, the worker must
    // also register those entities or TypeORM fails to build the metadata.
    // UsersModule registers User and, through ChannelsModule, Channel.
    UsersModule,
    StorageModule,
    MediaModule,
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessingService, VideoProcessor],
})
export class VideoProcessingModule {}

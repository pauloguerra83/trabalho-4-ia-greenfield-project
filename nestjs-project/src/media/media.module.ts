import { Module } from '@nestjs/common';
import { COMMAND_RUNNER, execFileRunner } from './command-runner';
import { MediaService } from './media.service';

@Module({
  providers: [
    { provide: COMMAND_RUNNER, useValue: execFileRunner },
    MediaService,
  ],
  exports: [MediaService],
})
export class MediaModule {}

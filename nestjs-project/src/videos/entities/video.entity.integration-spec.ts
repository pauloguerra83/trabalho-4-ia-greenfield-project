import { randomUUID } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generateSlug } from '../slug.util';
import type { VideoMetadata } from '../video-metadata';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10737418240;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    // Exercise the schema created by the CreateVideos and
    // LinkVideosToChannels migrations.
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await userRepository.save(
      userRepository.create({ email: 'owner@example.com', password: 'hash' }),
    );
    channel = await channelRepository.save(
      channelRepository.create({
        name: 'owner',
        nickname: 'owner',
        user_id: user.id,
      }),
    );
  });

  function buildVideo(overrides: Partial<Video> = {}): Video {
    const id = overrides.id ?? randomUUID();
    return videoRepository.create({
      id,
      channel_id: channel.id,
      source_key: `videos/${id}/source`,
      slug: generateSlug(),
      title: 'Minha aula',
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 1000,
      upload_id: 'upload-1',
      ...overrides,
    });
  }

  function pgErrorCode(error: unknown): string | undefined {
    return error instanceof QueryFailedError
      ? (error.driverError as { code?: string }).code
      : undefined;
  }

  it('should keep the application-assigned id', async () => {
    const id = randomUUID();

    await videoRepository.save(buildVideo({ id }));

    expect(await videoRepository.findOneBy({ id })).not.toBeNull();
  });

  it('should default status to draft and leave processing fields null', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.processing_error).toBeNull();
  });

  it('should reject two videos with the same slug', async () => {
    await videoRepository.save(buildVideo({ slug: 'AAAAAAAAAAA' }));

    const error: unknown = await videoRepository
      .save(buildVideo({ slug: 'AAAAAAAAAAA' }))
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe('23505');
  });

  it('should reject a status outside draft | processing | ready | failed', async () => {
    const error: unknown = await dataSource
      .query(
        `INSERT INTO "videos" ("id", "channel_id", "source_key", "slug", "title", "original_filename", "content_type", "size_bytes", "status")
         VALUES ($1, $2, 'videos/x/source', $3, 't', 'f.mp4', 'video/mp4', 1, 'published')`,
        [randomUUID(), channel.id, generateSlug()],
      )
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe('22P02');
  });

  it('should reject a video whose channel does not exist', async () => {
    const error: unknown = await videoRepository
      .save(buildVideo({ channel_id: randomUUID() }))
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe('23503');
  });

  it('should reject a video without source_key', async () => {
    const error: unknown = await dataSource
      .query(
        `INSERT INTO "videos" ("id", "channel_id", "slug", "title", "original_filename", "content_type", "size_bytes")
         VALUES ($1, $2, $3, 't', 'f.mp4', 'video/mp4', 1)`,
        [randomUUID(), channel.id, generateSlug()],
      )
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe('23502');
  });

  it('should read size_bytes back as a number up to 10 GiB', async () => {
    const saved = await videoRepository.save(
      buildVideo({ size_bytes: TEN_GIB }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(TEN_GIB);
  });

  it('should round-trip duration and the curated metadata json', async () => {
    const metadata: VideoMetadata = {
      format: {
        name: 'mov,mp4,m4a,3gp,3g2,mj2',
        durationSeconds: 4.5,
        sizeBytes: 51230,
        bitRate: 91076,
      },
      video: {
        codec: 'h264',
        width: 1920,
        height: 1080,
        frameRate: 29.97,
        bitRate: null,
      },
      audio: null,
    };
    const saved = await videoRepository.save(
      buildVideo({ duration_seconds: 4.5, metadata }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.duration_seconds).toBe(4.5);
    expect(found.metadata).toEqual(metadata);
  });
});

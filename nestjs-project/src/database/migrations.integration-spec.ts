import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1791245075044 } from './migrations/1791245075044-CreateVideos';
import { LinkVideosToChannels1791308343731 } from './migrations/1791308343731-LinkVideosToChannels';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

// Enum types survive DROP TABLE; leaving them makes the migrations'
// CREATE TYPE fail on an already-migrated database.
const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'videos_status_enum',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1791245075044,
          LinkVideosToChannels1791308343731,
        ],
      },
    );

    await dataSource.initialize();

    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    for (const type of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "${type}"`);
    }
  });

  afterAll(async () => {
    // The last tests undo migrations, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  async function videoColumns(): Promise<string[]> {
    const rows = await dataSource.query<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    return rows.map((r) => r.column_name);
  }

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(4);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
    const columns = await videoColumns();
    expect(columns).toEqual(
      expect.arrayContaining(['channel_id', 'source_key']),
    );
    expect(columns).not.toContain('user_id');
  });

  it('should move existing videos to their owner channel and back', async () => {
    // Back to the CreateVideos schema, where videos still point to users.
    await dataSource.undoLastMigration();
    expect(await videoColumns()).toContain('user_id');

    const userId = randomUUID();
    const channelId = randomUUID();
    const videoId = randomUUID();
    await dataSource.query(
      `INSERT INTO "users" ("id", "email", "password") VALUES ($1, 'legacy@example.com', 'hash')`,
      [userId],
    );
    await dataSource.query(
      `INSERT INTO "channels" ("id", "name", "nickname", "user_id") VALUES ($1, 'legacy', 'legacy', $2)`,
      [channelId, userId],
    );
    await dataSource.query(
      `INSERT INTO "videos" ("id", "user_id", "slug", "title", "original_filename", "content_type", "size_bytes")
       VALUES ($1, $2, 'AAAAAAAAAAA', 't', 'f.mp4', 'video/mp4', 1)`,
      [videoId, userId],
    );

    await dataSource.runMigrations();

    const [migrated] = await dataSource.query<
      { channel_id: string; source_key: string }[]
    >(`SELECT "channel_id", "source_key" FROM "videos" WHERE "id" = $1`, [
      videoId,
    ]);
    expect(migrated).toEqual({
      channel_id: channelId,
      source_key: `videos/${videoId}/source`,
    });

    await dataSource.undoLastMigration();

    const [reverted] = await dataSource.query<{ user_id: string }[]>(
      `SELECT "user_id" FROM "videos" WHERE "id" = $1`,
      [videoId],
    );
    expect(reverted).toEqual({ user_id: userId });
    const columns = await videoColumns();
    expect(columns).not.toContain('channel_id');
    expect(columns).not.toContain('source_key');
  });

  it('should revert CreateVideos and remove the videos table and its enum', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(tables).toHaveLength(0);

    const types = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
    );
    expect(types).toHaveLength(0);
  });
});

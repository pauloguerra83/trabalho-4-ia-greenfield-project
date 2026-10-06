import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import type { VideoMetadata } from '../video-metadata';
import { VideoStatus } from '../video-status.enum';

/** `pg` returns bigint as string; sizes up to 10 GiB fit in a JS number. */
const bigintToNumber = {
  to: (value: number): number => value,
  from: (value: string): number => Number(value),
};

@Entity('videos')
export class Video {
  // Assigned by the application before the multipart upload starts, because
  // storage keys are derived from it.
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 127 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  size_bytes: number;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  // No inverse side on User, same as RefreshToken and VerificationToken: adding
  // it would force every DataSource that loads User to also load Video.
  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;
}

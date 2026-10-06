import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1791245075044 implements MigrationInterface {
  name = 'CreateVideos1791245075044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "slug" character varying(11) NOT NULL, "title" character varying(255) NOT NULL, "original_filename" character varying(255) NOT NULL, "content_type" character varying(127) NOT NULL, "size_bytes" bigint NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "upload_id" character varying, "thumbnail_key" character varying, "duration_seconds" double precision, "metadata" jsonb, "processing_error" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5dbcc1ee100f853490582eccc71" UNIQUE ("slug"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_900733992fb36a6d855308c003" ON "videos" ("user_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_900733992fb36a6d855308c0039" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_900733992fb36a6d855308c0039"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_900733992fb36a6d855308c003"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}

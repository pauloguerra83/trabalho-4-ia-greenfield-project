/** Curated summary of the ffprobe `format` section. */
export interface MediaFormatSummary {
  name: string;
  durationSeconds: number;
  sizeBytes: number | null;
  bitRate: number | null;
}

/** Curated summary of the first video stream. */
export interface MediaVideoSummary {
  codec: string;
  width: number;
  height: number;
  frameRate: number | null;
  bitRate: number | null;
}

/** Curated summary of the first audio stream. */
export interface MediaAudioSummary {
  codec: string;
  channels: number | null;
  sampleRate: number | null;
}

export interface MediaMetadata {
  format: MediaFormatSummary;
  video: MediaVideoSummary;
  audio: MediaAudioSummary | null;
}

export interface MediaProbeResult {
  durationSeconds: number;
  metadata: MediaMetadata;
}

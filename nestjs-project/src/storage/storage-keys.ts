const VIDEOS_PREFIX = 'videos';

export function sourceKey(videoId: string): string {
  return `${VIDEOS_PREFIX}/${videoId}/source`;
}

export function thumbnailKey(videoId: string): string {
  return `${VIDEOS_PREFIX}/${videoId}/thumbnail.jpg`;
}

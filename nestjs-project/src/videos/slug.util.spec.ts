import { generateSlug } from './slug.util';

describe('generateSlug', () => {
  it('should return 11 characters from the base64url alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSlug()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should return distinct values across calls', () => {
    const slugs = new Set(Array.from({ length: 1000 }, () => generateSlug()));

    expect(slugs.size).toBe(1000);
  });
});

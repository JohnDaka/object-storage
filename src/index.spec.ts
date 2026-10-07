import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as entry from './index.ts';

describe('@dakaio/object-storage', () => {
  it('exports what its README lists, and nothing else: no sharp, no helper of its own', () => {
    assert.deepEqual(Object.keys(entry).sort(), [
      'HTTP_METHOD',
      'IMMUTABLE_CACHE_CONTROL',
      'LocalStorage',
      'MEDIA_STORAGE_ERROR',
      'MediaObjectMissingError',
      'MediaStorageError',
      'PRIVATE_CACHE_CONTROL',
      'S3Storage',
      'ensureBuckets',
      'publicKeyIn',
      'r2EndpointOf',
    ]);
  });

  it('keeps its cache rules as browsers and CDNs read them', () => {
    assert.equal(entry.IMMUTABLE_CACHE_CONTROL, 'public, max-age=31536000, immutable');
    assert.equal(entry.PRIVATE_CACHE_CONTROL, 'private');
  });
});

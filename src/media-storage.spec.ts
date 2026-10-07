import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicKeyIn } from './media-storage.ts';
import type { MediaStorage } from './media-storage.ts';

/** Where the stand-in store serves its objects. */
const BASE = 'https://cdn.example.com';

/** Just the store's addresses, which is all publicKeyIn reads. */
const storage: Pick<MediaStorage, 'urlOf'> = { urlOf: (key) => `${BASE}/${key}` };

describe('publicKeyIn', () => {
  it('finds the key behind one of its own addresses in the folder', () => {
    assert.equal(publicKeyIn(storage, 'avatars', `${BASE}/avatars/1.jpg`), 'avatars/1.jpg');
    assert.equal(
      publicKeyIn(storage, 'avatars', `${BASE}/avatars/2026/1.jpg`),
      'avatars/2026/1.jpg',
    );
  });

  it('takes a folder several levels deep', () => {
    assert.equal(publicKeyIn(storage, 'p/katya', `${BASE}/p/katya/1.webp`), 'p/katya/1.webp');
  });

  it('finds nothing in another folder, even one whose name starts the same', () => {
    assert.equal(publicKeyIn(storage, 'avatars', `${BASE}/covers/1.webp`), null);
    assert.equal(publicKeyIn(storage, 'avatars', `${BASE}/avatars-old/1.jpg`), null);
  });

  it("finds nothing behind an address that is not the store's", () => {
    assert.equal(
      publicKeyIn(storage, 'avatars', 'https://lh3.googleusercontent.com/avatars/1.jpg'),
      null,
    );
    assert.equal(publicKeyIn(storage, 'avatars', 'avatars/1.jpg'), null);
  });

  it('finds nothing when there is no address at all', () => {
    assert.equal(publicKeyIn(storage, 'avatars', null), null);
    // From a caller without types, as a row's empty column comes.
    assert.equal(publicKeyIn(storage, 'avatars', undefined as unknown as null), null);
  });
});

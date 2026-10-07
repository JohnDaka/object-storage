import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MEDIA_STORAGE_ERROR, MediaObjectMissingError, MediaStorageError } from './errors.ts';
import { LocalStorage } from './local-storage.ts';
import { publicKeyIn } from './media-storage.ts';

/** What a refused key is told. */
const OUTSIDE = { name: MediaStorageError.name, code: MEDIA_STORAGE_ERROR.KEY_OUTSIDE_FOLDER };

describe('LocalStorage', () => {
  let parent: string;
  let dir: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'object-storage-'));
    dir = join(parent, 'media');
    storage = new LocalStorage({ dir, publicUrl: '/api/v1/media/' });
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('puts an object in its folder, reads it back and says where it is served', async () => {
    await storage.put('p/katya/a.webp', Buffer.from('pixels'), 'image/webp');

    assert.equal((await readFile(join(dir, 'p', 'katya', 'a.webp'))).toString(), 'pixels');
    assert.equal((await storage.get('p/katya/a.webp')).toString(), 'pixels');
    assert.equal(storage.urlOf('p/katya/a.webp'), '/api/v1/media/p/katya/a.webp');
    assert.equal(publicKeyIn(storage, 'p/katya', '/api/v1/media/p/katya/a.webp'), 'p/katya/a.webp');
  });

  it('replaces what was under the key', async () => {
    await storage.put('p/a.webp', Buffer.from('old'), 'image/webp');
    await storage.put('p/a.webp', Buffer.from('new'), 'image/webp');

    assert.equal((await storage.get('p/a.webp')).toString(), 'new');
  });

  it('is served at a whole address as well as at a path of its own origin', () => {
    const served = new LocalStorage({ dir, publicUrl: 'http://localhost:3000/media' });

    assert.equal(served.urlOf('p/a.webp'), 'http://localhost:3000/media/p/a.webp');
  });

  it('takes its folder from the working directory as well', async () => {
    const fromHere = new LocalStorage({ dir: relative(process.cwd(), dir), publicUrl: '/media' });

    await fromHere.put('p/a.webp', Buffer.from('x'), 'image/webp');

    assert.equal(existsSync(join(dir, 'p', 'a.webp')), true);
  });

  it('says a missing object is missing, and deleting it is no failure', async () => {
    await assert.rejects(storage.get('p/none.webp'), (error) => {
      assert.ok(error instanceof MediaObjectMissingError);
      assert.equal(error.code, MEDIA_STORAGE_ERROR.OBJECT_MISSING);
      assert.equal(error.message, 'No object at p/none.webp');
      return true;
    });
    await storage.delete('p/none.webp');

    await storage.put('p/a.webp', Buffer.from('x'), 'image/webp');
    await storage.delete('p/a.webp');
    assert.equal(existsSync(join(dir, 'p', 'a.webp')), false);
  });

  it("passes on the file system's own error for anything but a missing file", async () => {
    await storage.put('p/a/1.webp', Buffer.from('x'), 'image/webp');

    await assert.rejects(storage.get('p/a'), (error) => {
      assert.ok(!(error instanceof MediaStorageError));
      assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR');
      return true;
    });
  });

  it('deletes a whole folder, and takes a missing one for no failure', async () => {
    await storage.put('p/a/1.webp', Buffer.from('1'), 'image/webp');
    await storage.put('p/a/thumbs/1.webp', Buffer.from('2'), 'image/webp');
    await storage.put('p/ab/1.webp', Buffer.from('3'), 'image/webp');

    await storage.deleteFolder('p/a');
    await storage.deleteFolder('p/none');

    assert.equal(existsSync(join(dir, 'p', 'a')), false);
    assert.equal(existsSync(join(dir, 'p', 'ab', '1.webp')), true);
  });

  it('builds no path outside its folder, nor the folder itself', async () => {
    const keys = [
      '../escape.txt',
      'p/../../escape.txt',
      '../media-next-door/x.txt',
      '',
      '.',
      'p/..',
    ];

    for (const key of keys) {
      await assert.rejects(storage.put(key, Buffer.from('x'), 'text/plain'), OUTSIDE);
      await assert.rejects(storage.get(key), OUTSIDE);
      await assert.rejects(storage.delete(key), OUTSIDE);
      await assert.rejects(storage.deleteFolder(key), OUTSIDE);
    }
    assert.equal(existsSync(join(parent, 'escape.txt')), false);
    assert.equal(existsSync(join(parent, 'media-next-door')), false);
  });

  it('names the key it refused', async () => {
    await assert.rejects(storage.put('../escape.txt', Buffer.from('x'), 'text/plain'), {
      ...OUTSIDE,
      message: 'A media key outside the folder: ../escape.txt',
    });
  });

  it('takes a key that only passes through a folder on its way back in', async () => {
    await storage.put('p/../q/a.webp', Buffer.from('x'), 'image/webp');

    assert.equal(existsSync(join(dir, 'q', 'a.webp')), true);
  });

  it('keeps everything when asked to delete a folder with no name', async () => {
    await storage.put('p/a.webp', Buffer.from('x'), 'image/webp');

    await assert.rejects(storage.deleteFolder(''), OUTSIDE);

    assert.equal(existsSync(join(dir, 'p', 'a.webp')), true);
  });
});

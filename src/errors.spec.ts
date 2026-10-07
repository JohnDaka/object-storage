import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MEDIA_STORAGE_ERROR, MediaObjectMissingError, MediaStorageError } from './errors.ts';

describe('MediaStorageError', () => {
  it('has a code for each failure, its own name', () => {
    assert.deepEqual(Object.keys(MEDIA_STORAGE_ERROR), Object.values(MEDIA_STORAGE_ERROR));
  });

  it('says what an S3 store refused, carrying its status and its answer', () => {
    const error = new MediaStorageError(MEDIA_STORAGE_ERROR.STORE_REFUSED, 'PUT /media/p/a.webp', {
      status: 403,
      text: '<Error><Code>AccessDenied</Code></Error>',
    });

    assert.ok(error instanceof Error);
    assert.equal(error.name, MediaStorageError.name);
    assert.equal(error.code, MEDIA_STORAGE_ERROR.STORE_REFUSED);
    assert.equal(error.status, 403);
    assert.equal(
      error.message,
      'The S3 store answered 403 to PUT /media/p/a.webp: <Error><Code>AccessDenied</Code></Error>',
    );
  });

  it('names the key that would leave the local folder', () => {
    const error = new MediaStorageError(MEDIA_STORAGE_ERROR.KEY_OUTSIDE_FOLDER, '../x');

    assert.equal(error.code, MEDIA_STORAGE_ERROR.KEY_OUTSIDE_FOLDER);
    assert.equal(error.status, undefined);
    assert.equal(error.message, 'A media key outside the folder: ../x');
  });

  it('names the private bucket asked for a public address', () => {
    const error = new MediaStorageError(MEDIA_STORAGE_ERROR.NO_PUBLIC_URL, 'uploads');

    assert.equal(error.code, MEDIA_STORAGE_ERROR.NO_PUBLIC_URL);
    assert.equal(
      error.message,
      'The bucket uploads has no publicUrl: its objects are read through signedUrlOf',
    );
  });

  it('can be made with no particulars at all', () => {
    const error = new MediaStorageError(MEDIA_STORAGE_ERROR.OBJECT_MISSING);

    assert.equal(error.message, 'No object at ');
    assert.equal(error.status, undefined);
  });
});

describe('MediaObjectMissingError', () => {
  it('is a missing object, caught along with every other failure of a store', () => {
    const error = new MediaObjectMissingError('media/p/a.webp');

    assert.ok(error instanceof MediaStorageError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, MediaObjectMissingError.name);
    assert.equal(error.code, MEDIA_STORAGE_ERROR.OBJECT_MISSING);
    assert.equal(error.status, undefined);
    assert.equal(error.message, 'No object at media/p/a.webp');
  });
});

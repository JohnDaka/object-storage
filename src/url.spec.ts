import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { folderPrefixOf, joinedPath, withoutTrailingSlashes, withQuery } from './url.ts';

describe('withoutTrailingSlashes', () => {
  it('drops every slash at the end, and nothing else', () => {
    assert.equal(withoutTrailingSlashes('https://cdn.example.com/'), 'https://cdn.example.com');
    assert.equal(withoutTrailingSlashes('https://cdn.example.com///'), 'https://cdn.example.com');
    assert.equal(withoutTrailingSlashes('/api/v1/media'), '/api/v1/media');
    assert.equal(
      withoutTrailingSlashes('https://cdn.example.com/a/b'),
      'https://cdn.example.com/a/b',
    );
  });

  it('leaves nothing of an address that is slashes alone', () => {
    assert.equal(withoutTrailingSlashes('/'), '');
    assert.equal(withoutTrailingSlashes(''), '');
  });
});

describe('joinedPath', () => {
  it('puts one slash between each two parts', () => {
    assert.equal(
      joinedPath('http://localhost:9000', 'media', 'p/a.webp'),
      'http://localhost:9000/media/p/a.webp',
    );
    assert.equal(joinedPath('https://cdn.example.com', ''), 'https://cdn.example.com/');
    assert.equal(joinedPath('only'), 'only');
  });
});

describe('folderPrefixOf', () => {
  it('is the folder and a slash, so a neighbour whose name starts the same is not in it', () => {
    const prefix = folderPrefixOf('p/a');

    assert.equal(prefix, 'p/a/');
    assert.equal('p/a/1.webp'.startsWith(prefix), true);
    assert.equal('p/ab/1.webp'.startsWith(prefix), false);
  });
});

describe('withQuery', () => {
  it('URI-encodes every name and value: a space as %20, a plus and a slash escaped', () => {
    assert.equal(
      withQuery('https://s3/media', { 'list-type': '2', prefix: 'p/a b+c/', token: 'x=y' }),
      'https://s3/media?list-type=2&prefix=p%2Fa%20b%2Bc%2F&token=x%3Dy',
    );
  });

  it('writes a parameter with no value as its name and an equals sign', () => {
    assert.equal(withQuery('https://s3/media', { delete: '' }), 'https://s3/media?delete=');
  });

  it('leaves an address with nothing to ask as it is, without a question mark', () => {
    assert.equal(withQuery('https://s3/media/p/a.webp', {}), 'https://s3/media/p/a.webp');
  });
});

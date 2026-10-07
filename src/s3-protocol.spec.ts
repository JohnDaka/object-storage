import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  escapeXml,
  HTTP_METHOD,
  requestOf,
  S3_XML_TAG,
  unescapeXml,
  xmlElementOf,
  xmlValuesOf,
} from './s3-protocol.ts';

describe('HTTP_METHOD', () => {
  it('names each method as HTTP writes it', () => {
    for (const [name, method] of Object.entries(HTTP_METHOD)) {
      assert.equal(method, name);
    }
    assert.deepEqual(Object.values(HTTP_METHOD).sort(), ['DELETE', 'GET', 'HEAD', 'POST', 'PUT']);
  });
});

describe('escapeXml', () => {
  it('writes every character XML would read as markup as its entity', () => {
    assert.equal(escapeXml(`R&D <b> "q" it's`), 'R&amp;D &lt;b&gt; &quot;q&quot; it&apos;s');
  });

  it('leaves any other text as it is', () => {
    assert.equal(escapeXml('p/katya/1.webp'), 'p/katya/1.webp');
    assert.equal(escapeXml(''), '');
  });
});

describe('unescapeXml', () => {
  it('reads the named entities back', () => {
    assert.equal(unescapeXml('R&amp;D &lt;b&gt; &quot;q&quot; it&apos;s'), `R&D <b> "q" it's`);
  });

  it('reads a character by its number, decimal or hexadecimal', () => {
    assert.equal(unescapeXml('it&#39;s'), "it's");
    assert.equal(unescapeXml('it&#x27;s'), "it's");
    assert.equal(unescapeXml('&#x1F600;'), String.fromCodePoint(0x1f600));
  });

  it('leaves an entity XML does not name as it is', () => {
    assert.equal(unescapeXml('a&nbsp;b'), 'a&nbsp;b');
    assert.equal(unescapeXml('a & b'), 'a & b');
  });

  it('turns back whatever escapeXml wrote', () => {
    const text = `p/x/R&D <draft> "final" it's.webp`;

    assert.equal(unescapeXml(escapeXml(text)), text);
  });
});

describe('xmlElementOf', () => {
  it('wraps the content in the tag, with the attributes after its name', () => {
    assert.equal(xmlElementOf('Key', 'a'), '<Key>a</Key>');
    assert.equal(xmlElementOf('Delete', '', ' xmlns="x"'), '<Delete xmlns="x"></Delete>');
  });
});

describe('xmlValuesOf', () => {
  const listing =
    '<ListBucketResult><IsTruncated>true</IsTruncated>' +
    '<Contents><Key>p/1.webp</Key><Size>1</Size></Contents>' +
    '<Contents><Key>p/R&amp;D.webp</Key><Size>2</Size></Contents>' +
    '<NextContinuationToken>t+/=</NextContinuationToken></ListBucketResult>';

  it("reads every element's text, in order, unescaped", () => {
    assert.deepEqual(xmlValuesOf(listing, S3_XML_TAG.KEY), ['p/1.webp', 'p/R&D.webp']);
    assert.deepEqual(xmlValuesOf(listing, S3_XML_TAG.IS_TRUNCATED), ['true']);
    assert.deepEqual(xmlValuesOf(listing, S3_XML_TAG.NEXT_CONTINUATION_TOKEN), ['t+/=']);
  });

  it('reads nothing of a tag the answer does not have', () => {
    assert.deepEqual(xmlValuesOf('<ListBucketResult></ListBucketResult>', S3_XML_TAG.KEY), []);
  });
});

describe('requestOf', () => {
  it('names a request as an error message shows it', () => {
    assert.equal(requestOf(HTTP_METHOD.PUT, 'media/p/a.webp'), 'PUT /media/p/a.webp');
  });
});

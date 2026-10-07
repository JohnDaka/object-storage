import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ensureBuckets } from './ensure-buckets.ts';
import { MEDIA_STORAGE_ERROR, MediaObjectMissingError, MediaStorageError } from './errors.ts';
import { publicKeyIn } from './media-storage.ts';
import { HTTP_METHOD, R2_REGION, S3_MAX_KEYS, S3_QUERY } from './s3-protocol.ts';
import {
  IMMUTABLE_CACHE_CONTROL,
  PRIVATE_CACHE_CONTROL,
  r2EndpointOf,
  S3Storage,
} from './s3-storage.ts';
import type { S3StorageOptions } from './s3-storage.ts';

const KEYS = { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' };

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();
/** A name or a value as SigV4 writes it: RFC 3986, every reserved character escaped. */
const encode = (text: string): string =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const byNameThenValue = ([a, x]: string[], [b, y]: string[]): number =>
  a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0;

interface SignedRequest {
  method: string;
  url: URL;
  header: (name: string) => string | null;
}

/**
 * Checks a request's SigV4 signature the way S3 does, rebuilt from the rules rather than taken
 * from aws4fetch: a mistake in what the store has signed shows up here instead of being repeated.
 * By its Authorization header, or by the query of a link signed in advance. Gives the region the
 * request was signed for.
 */
const verifySignature = ({ method, url, header }: SignedRequest): { region: string } => {
  const query = url.searchParams;
  const authorization = header('authorization');
  let credential: string;
  let signedHeaders: string;
  let signature: string;
  let datetime: string;
  let payloadHash: string;
  if (authorization) {
    const parts =
      /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        authorization,
      );
    assert.ok(parts, `An Authorization of the wrong shape: ${authorization}`);
    [, credential, signedHeaders, signature] = parts;
    datetime = header('x-amz-date') ?? '';
    payloadHash = header('x-amz-content-sha256') ?? '';
  } else {
    assert.equal(query.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    credential = query.get('X-Amz-Credential') ?? '';
    signedHeaders = query.get('X-Amz-SignedHeaders') ?? '';
    signature = query.get('X-Amz-Signature') ?? '';
    datetime = query.get('X-Amz-Date') ?? '';
    payloadHash = 'UNSIGNED-PAYLOAD';
  }

  const [accessKeyId, date, region, service, terminator] = credential.split('/');
  assert.equal(accessKeyId, KEYS.accessKeyId);
  assert.equal(date, datetime.slice(0, 8));
  assert.equal(service, 's3');
  assert.equal(terminator, 'aws4_request');

  const canonicalPath = url.pathname
    .split('/')
    .map((segment) => encode(decodeURIComponent(segment)))
    .join('/');
  const canonicalQuery = [...query]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(byNameThenValue)
    .map((pair) => pair.join('='))
    .join('&');
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => `${name}:${(header(name) ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = [date, region, 's3', 'aws4_request'].join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${KEYS.secretAccessKey}`, date), region), 's3'),
    'aws4_request',
  );

  assert.equal(signature, createHmac('sha256', signingKey).update(stringToSign).digest('hex'));
  return { region };
};

/** A request as it left: what fetch was called with, checked as S3 would check it. */
const verifyRequest = (request: Request): { region: string } => {
  const url = new URL(request.url);
  return verifySignature({
    method: request.method,
    url,
    header: (name) => (name === 'host' ? url.host : request.headers.get(name)),
  });
};

/** `20261007T101500Z` as an instant. */
const instantOf = (datetime: string): number =>
  Date.UTC(
    Number(datetime.slice(0, 4)),
    Number(datetime.slice(4, 6)) - 1,
    Number(datetime.slice(6, 8)),
    Number(datetime.slice(9, 11)),
    Number(datetime.slice(11, 13)),
    Number(datetime.slice(13, 15)),
  );

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  // Numeric, as some stores write it: the client has to read both kinds.
  "'": '&#39;',
};
const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};
const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
const unescapeXml = (text: string): string =>
  text.replace(/&[a-z]+;/g, (entity) => XML_ENTITIES[entity] ?? entity);
const XML = '<?xml version="1.0" encoding="UTF-8"?>';

interface StoredObject {
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
}

/** A request as the fake store took it: signed right, so its region is known. */
interface Logged {
  method: string;
  path: string;
  query: URLSearchParams;
  region: string;
}

/** Never refuses. */
const refuseNothing = (): boolean => false;

/**
 * Just enough of S3 for the store: buckets and their policies, objects, listings a page at a time
 * and batch deletes, every request's signature checked. Missing buckets and keys are 404s and a
 * bucket made twice a 409, as MinIO answers them. `state.refuse` picks the requests answered with
 * a 403 AccessDenied, as for a token without the right.
 */
const fakeS3 = () => {
  const buckets = new Map<string, Map<string, StoredObject>>();
  const policies = new Map<string, string>();
  const requests: Logged[] = [];
  const deleteBatches: number[] = [];
  /** Continuation tokens, made of the characters a query has to escape. */
  const tokens = new Map<string, string>();
  const state = {
    refuse: refuseNothing as (request: Logged) => boolean,
    missingDeleteIs404: false,
  };

  const reset = (): void => {
    buckets.clear();
    policies.clear();
    requests.length = 0;
    deleteBatches.length = 0;
    tokens.clear();
    state.refuse = refuseNothing;
    state.missingDeleteIs404 = false;
  };

  const listing = (name: string, bucket: Map<string, StoredObject>, query: URLSearchParams) => {
    const prefix = query.get('prefix') ?? '';
    const maxKeys = Math.min(Number(query.get('max-keys') ?? 1000), 1000);
    const token = query.get('continuation-token');
    const after = token === null ? undefined : tokens.get(token);
    if (token !== null && after === undefined) {
      return null;
    }

    const keys = [...bucket.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .filter((key) => after === undefined || key > after);
    const page = keys.slice(0, maxKeys);
    const truncated = keys.length > maxKeys;
    let next = '';
    if (truncated) {
      const nextToken = `page+/=${tokens.size + 1}`;
      tokens.set(nextToken, page[page.length - 1]);
      next = `<NextContinuationToken>${nextToken}</NextContinuationToken>`;
    }
    const contents = page
      .map((key) => `<Contents><Key>${escapeXml(key)}</Key><Size>1</Size></Contents>`)
      .join('');

    return (
      `${XML}<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<Name>${name}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
      `<MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}` +
      '</ListBucketResult>'
    );
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    const answer = (status: number, xml = ''): void => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(xml);
    };
    const fail = (status: number, code: string): void =>
      answer(status, `${XML}<Error><Code>${code}</Code><Message>${code}</Message></Error>`);

    let region: string;
    try {
      ({ region } = verifySignature({
        method,
        url,
        header: (name) => {
          const value = req.headers[name];
          return Array.isArray(value) ? value.join(',') : (value ?? null);
        },
      }));
    } catch {
      return fail(403, 'SignatureDoesNotMatch');
    }
    const logged = { method, path: url.pathname, query: url.searchParams, region };
    requests.push(logged);
    if (state.refuse(logged)) {
      return fail(403, 'AccessDenied');
    }
    const expires = url.searchParams.get('X-Amz-Expires');
    if (expires !== null) {
      const signedAt = instantOf(url.searchParams.get('X-Amz-Date') ?? '');
      const expired = Date.now() > signedAt + Number(expires) * 1000;
      if (expired) {
        return fail(403, 'AccessDenied');
      }
    }

    const [, name, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    const bucket = buckets.get(name);

    if (!key && method === 'PUT' && url.searchParams.has('policy')) {
      if (!bucket) {
        return fail(404, 'NoSuchBucket');
      }
      policies.set(name, body.toString());
      return answer(204);
    }
    if (!key && method === 'PUT') {
      if (bucket) {
        return fail(409, 'BucketAlreadyOwnedByYou');
      }
      buckets.set(name, new Map());
      return answer(200);
    }
    if (!bucket) {
      return fail(404, 'NoSuchBucket');
    }
    if (!key && method === 'GET' && url.searchParams.get('list-type') === '2') {
      const xml = listing(name, bucket, url.searchParams);
      return xml === null ? fail(400, 'InvalidArgument') : answer(200, xml);
    }
    if (!key && method === 'POST' && url.searchParams.has('delete')) {
      const checksum = createHash('md5').update(body).digest('base64');
      if (req.headers['content-md5'] !== checksum) {
        return fail(400, 'InvalidDigest');
      }
      const xml = body.toString();
      const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map(([, value]) => unescapeXml(value));
      if (keys.length > 1000 || !xml.includes('<Quiet>true</Quiet>')) {
        return fail(400, 'MalformedXML');
      }
      keys.forEach((deleted) => bucket.delete(deleted));
      deleteBatches.push(keys.length);
      return answer(200, `${XML}<DeleteResult></DeleteResult>`);
    }

    if (method === 'PUT') {
      bucket.set(key, {
        body,
        contentType: req.headers['content-type'],
        cacheControl: req.headers['cache-control'],
      });
      return answer(200);
    }
    if (method === 'GET' || method === 'HEAD') {
      const object = bucket.get(key);
      if (!object) {
        return fail(404, 'NoSuchKey');
      }
      res.writeHead(200, {
        'content-type': object.contentType ?? 'application/octet-stream',
        'content-length': object.body.length,
      });
      res.end(method === 'GET' ? object.body : undefined);
      return;
    }
    if (method === 'DELETE') {
      const had = bucket.delete(key);
      return !had && state.missingDeleteIs404 ? fail(404, 'NoSuchKey') : answer(204);
    }
    return fail(405, 'MethodNotAllowed');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });

  return { server, buckets, policies, requests, deleteBatches, state, reset };
};

const s3 = fakeS3();
let endpoint = '';

before(async () => {
  await new Promise<void>((listening) => s3.server.listen(0, '127.0.0.1', listening));
  endpoint = `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`;
});

after(() => {
  s3.server.closeAllConnections();
  s3.server.close();
});

const storageOf = (options: Partial<S3StorageOptions> = {}): S3Storage =>
  new S3Storage({ endpoint, ...KEYS, region: 'us-east-1', bucket: 'media', ...options });

/** Keys put straight into the store, as if uploaded long ago. */
const seed = (keys: string[]): void => {
  const bucket = s3.buckets.get('media')!;
  for (const key of keys) {
    bucket.set(key, { body: Buffer.from(key) });
  }
};

/** Refuses every request. */
const refuseAll = (): boolean => true;

/** A failure of the store's, with its code and, for a refusal, its status. */
const failure = (code: string, status?: number) => ({ name: MediaStorageError.name, code, status });

/** Answers every request with what `respond` makes of it, and keeps what was sent. */
const fakeFetch = (respond: (request: Request) => string | null = () => null) => {
  const sent: Request[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    sent.push(request);
    return new Response(respond(request), { status: 200 });
  };
  return { sent, fetch };
};

describe('r2EndpointOf', () => {
  it('reaches a bucket made in the EU at its own address, any other at the ordinary one', () => {
    assert.equal(r2EndpointOf('95b0c0ffee'), 'https://95b0c0ffee.r2.cloudflarestorage.com');
    assert.equal(r2EndpointOf('95b0c0ffee', ''), 'https://95b0c0ffee.r2.cloudflarestorage.com');
    assert.equal(
      r2EndpointOf('95b0c0ffee', 'eu'),
      'https://95b0c0ffee.eu.r2.cloudflarestorage.com',
    );
    assert.equal(
      r2EndpointOf('95b0c0ffee', 'fedramp'),
      'https://95b0c0ffee.fedramp.r2.cloudflarestorage.com',
    );
  });
});

describe('S3Storage, as it signs and addresses its requests', () => {
  const r2 = (options: Partial<S3StorageOptions> = {}): S3Storage =>
    new S3Storage({
      endpoint: r2EndpointOf('95b0c0ffee', 'eu'),
      ...KEYS,
      bucket: 'media',
      publicUrl: 'https://cdn.example.com/',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      ...options,
    });

  it('puts path-style at the endpoint, signed for R2 with the type and the Cache-Control', async (t) => {
    const { sent, fetch } = fakeFetch();
    t.mock.method(globalThis, 'fetch', fetch);

    await r2().put('p/katya/abc.webp', Buffer.from('pixels'), 'image/webp');

    assert.equal(sent.length, 1);
    const [request] = sent;
    assert.equal(request.method, HTTP_METHOD.PUT);
    assert.equal(request.url, `${r2EndpointOf('95b0c0ffee', 'eu')}/media/p/katya/abc.webp`);
    assert.equal(request.headers.get('content-type'), 'image/webp');
    assert.equal(request.headers.get('cache-control'), IMMUTABLE_CACHE_CONTROL);
    assert.equal(request.headers.get('x-amz-content-sha256'), 'UNSIGNED-PAYLOAD');
    assert.equal(verifyRequest(request).region, R2_REGION);
    assert.equal(Buffer.from(await request.arrayBuffer()).toString(), 'pixels');
  });

  it('signs for the region it is given, and puts no Cache-Control it was not given', async (t) => {
    const { sent, fetch } = fakeFetch();
    t.mock.method(globalThis, 'fetch', fetch);

    await r2({ region: 'us-east-1', cacheControl: undefined }).put(
      'a.txt',
      Buffer.from('a'),
      'text/plain',
    );

    assert.equal(verifyRequest(sent[0]).region, 'us-east-1');
    assert.equal(sent[0].headers.get('cache-control'), null);
  });

  it("signs for R2's region when the one it is given is empty, as an unset setting comes", async (t) => {
    const { sent, fetch } = fakeFetch();
    t.mock.method(globalThis, 'fetch', fetch);

    await r2({ region: '' }).put('a.txt', Buffer.from('a'), 'text/plain');

    assert.equal(verifyRequest(sent[0]).region, R2_REGION);
  });

  it('lists a folder with its query escaped, and deletes the page in one signed batch', async (t) => {
    // As XML writes them, in the listing and in the batch alike.
    const keys = ['p/a b/1.webp', 'p/a b/R&amp;D.webp'];
    const contents = keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('');
    const listing = `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
    const { sent, fetch } = fakeFetch((request) =>
      request.method === HTTP_METHOD.GET ? listing : '<DeleteResult/>',
    );
    t.mock.method(globalThis, 'fetch', fetch);

    await r2().deleteFolder('p/a b');

    const [list, batch] = sent;
    assert.equal(
      list.url,
      `${r2EndpointOf('95b0c0ffee', 'eu')}/media?list-type=2&prefix=p%2Fa%20b%2F&max-keys=${S3_MAX_KEYS}`,
    );
    verifyRequest(list);
    assert.equal(batch.method, HTTP_METHOD.POST);
    assert.equal(batch.url, `${r2EndpointOf('95b0c0ffee', 'eu')}/media?delete=`);
    assert.equal(batch.headers.get('content-type'), 'application/xml');
    verifyRequest(batch);
    const xml = await batch.text();
    const objects = keys.map((key) => `<Object><Key>${key}</Key></Object>`).join('');
    assert.ok(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      ),
      xml,
    );
    assert.ok(xml.endsWith(`<Quiet>true</Quiet>${objects}</Delete>`), xml);
    assert.equal(batch.headers.get('content-md5'), createHash('md5').update(xml).digest('base64'));
  });

  it('signs a link that carries its own expiry', async () => {
    const link = new URL(await r2().signedUrlOf('private/x.jpg', 600));

    assert.equal(
      link.origin + link.pathname,
      `${r2EndpointOf('95b0c0ffee', 'eu')}/media/private/x.jpg`,
    );
    assert.equal(link.searchParams.get(S3_QUERY.EXPIRES), '600');
    assert.equal(link.searchParams.get('X-Amz-SignedHeaders'), 'host');
    const signed = verifySignature({
      method: HTTP_METHOD.GET,
      url: link,
      header: (name) => (name === 'host' ? link.host : null),
    });
    assert.equal(signed.region, R2_REGION);
  });

  it('signs a link without asking the store anything', async (t) => {
    const { sent, fetch } = fakeFetch();
    t.mock.method(globalThis, 'fetch', fetch);

    await r2().signedUrlOf('private/x.jpg', 600);

    assert.equal(sent.length, 0);
  });

  it('builds the API address and the public one, which a private bucket does not have', () => {
    const storage = r2();

    assert.equal(storage.apiUrlOf(), `${r2EndpointOf('95b0c0ffee', 'eu')}/media`);
    assert.equal(
      storage.apiUrlOf('a/b.webp'),
      `${r2EndpointOf('95b0c0ffee', 'eu')}/media/a/b.webp`,
    );
    assert.equal(storage.urlOf('a/b.webp'), 'https://cdn.example.com/a/b.webp');
    for (const publicUrl of [undefined, '']) {
      assert.throws(() => r2({ publicUrl }).urlOf('a/b.webp'), {
        ...failure(MEDIA_STORAGE_ERROR.NO_PUBLIC_URL),
        message: 'The bucket media has no publicUrl: its objects are read through signedUrlOf',
      });
    }
  });

  it('finds the key behind one of its own public addresses in a folder, and nothing else', () => {
    const storage = r2();

    assert.equal(
      publicKeyIn(storage, 'avatars', 'https://cdn.example.com/avatars/1.jpg'),
      'avatars/1.jpg',
    );
    assert.equal(publicKeyIn(storage, 'avatars', 'https://cdn.example.com/covers/1.webp'), null);
    assert.equal(
      publicKeyIn(storage, 'avatars', 'https://lh3.googleusercontent.com/avatars/1.jpg'),
      null,
    );
    assert.equal(publicKeyIn(storage, 'avatars', null), null);
  });

  it('is configured only with both keys', () => {
    assert.equal(r2().configured, true);
    assert.equal(r2({ accessKeyId: '' }).configured, false);
    assert.equal(r2({ secretAccessKey: '' }).configured, false);
  });
});

describe('S3Storage, against an S3 store', () => {
  beforeEach(() => {
    s3.reset();
    s3.buckets.set('media', new Map());
  });

  it('puts an object with its type and Cache-Control, and reads it back', async () => {
    const storage = storageOf({ cacheControl: IMMUTABLE_CACHE_CONTROL });

    await storage.put('p/a.webp', Buffer.from('pixels'), 'image/webp');

    const stored = s3.buckets.get('media')!.get('p/a.webp');
    assert.equal(stored?.body.toString(), 'pixels');
    assert.equal(stored?.contentType, 'image/webp');
    assert.equal(stored?.cacheControl, IMMUTABLE_CACHE_CONTROL);
    assert.equal((await storage.get('p/a.webp')).toString(), 'pixels');
  });

  it('puts a private object with the private Cache-Control', async () => {
    await storageOf({ cacheControl: PRIVATE_CACHE_CONTROL }).put(
      'u/1.jpg',
      Buffer.from('face'),
      'image/jpeg',
    );

    assert.equal(s3.buckets.get('media')!.get('u/1.jpg')?.cacheControl, PRIVATE_CACHE_CONTROL);
  });

  it('replaces what was under the key', async () => {
    const storage = storageOf();

    await storage.put('p/a.webp', Buffer.from('old'), 'image/webp');
    await storage.put('p/a.webp', Buffer.from('new'), 'image/webp');

    assert.equal((await storage.get('p/a.webp')).toString(), 'new');
  });

  it("signs for R2's region when it is given none", async () => {
    const storage = storageOf({ region: undefined });

    await storage.put('p/a.webp', Buffer.from('pixels'), 'image/webp');

    assert.equal(s3.requests[0].region, R2_REGION);
  });

  it('reads back bytes of every value, not only text', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const storage = storageOf();

    await storage.put('p/raw.bin', bytes, 'application/octet-stream');

    assert.deepEqual(await storage.get('p/raw.bin'), bytes);
  });

  it('says a missing object is missing, which a retry will not change', async () => {
    await assert.rejects(storageOf().get('p/none.webp'), (error) => {
      assert.ok(error instanceof MediaObjectMissingError);
      assert.equal(error.code, MEDIA_STORAGE_ERROR.OBJECT_MISSING);
      assert.equal(error.name, MediaObjectMissingError.name);
      assert.equal(error.message, 'No object at media/p/none.webp');
      return true;
    });
  });

  it('says a missing bucket is missing, whatever is asked of it', async () => {
    const storage = storageOf({ bucket: 'no-such-bucket' });

    await assert.rejects(storage.get('p/a.webp'), MediaObjectMissingError);
    await assert.rejects(
      storage.put('p/a.webp', Buffer.from('x'), 'image/webp'),
      MediaObjectMissingError,
    );
    await assert.rejects(storage.deleteFolder('p'), MediaObjectMissingError);
  });

  it('deletes an object, and deleting one that is not there is no failure', async () => {
    const storage = storageOf();
    seed(['p/a.webp']);

    await storage.delete('p/a.webp');
    await storage.delete('p/a.webp');
    s3.state.missingDeleteIs404 = true;
    await storage.delete('p/a.webp');

    assert.equal(s3.buckets.get('media')!.size, 0);
  });

  it("throws anything else as the store's refusal, its status and answer in it", async () => {
    s3.state.refuse = refuseAll;

    await assert.rejects(storageOf().put('p/a.webp', Buffer.from('x'), 'image/webp'), (error) => {
      assert.ok(error instanceof MediaStorageError);
      assert.ok(!(error instanceof MediaObjectMissingError));
      assert.equal(error.code, MEDIA_STORAGE_ERROR.STORE_REFUSED);
      assert.equal(error.status, 403);
      assert.match(
        error.message,
        /^The S3 store answered 403 to PUT \/media\/p\/a\.webp: .*AccessDenied/,
      );
      return true;
    });
  });

  it('throws a refusal of a read, a delete and a folder alike', async () => {
    const storage = storageOf();
    seed(['p/a.webp']);
    s3.state.refuse = refuseAll;

    const refused = failure(MEDIA_STORAGE_ERROR.STORE_REFUSED, 403);
    await assert.rejects(storage.get('p/a.webp'), refused);
    await assert.rejects(storage.delete('p/a.webp'), refused);
    await assert.rejects(storage.deleteFolder('p'), refused);
    assert.equal(s3.buckets.get('media')!.size, 1);
  });

  it('throws a refusal of the batch delete, with the keys left where they were', async () => {
    seed(['p/a/1.webp']);
    s3.state.refuse = ({ method }) => method === HTTP_METHOD.POST;

    await assert.rejects(storageOf().deleteFolder('p/a'), {
      ...failure(MEDIA_STORAGE_ERROR.STORE_REFUSED, 403),
      message: /to POST \/media:/,
    });
    assert.equal(s3.buckets.get('media')!.size, 1);
  });

  it('is refused with keys that do not sign right', async () => {
    const storage = storageOf({ secretAccessKey: 'not-the-secret' });

    await assert.rejects(storage.put('p/a.webp', Buffer.from('x'), 'image/webp'), {
      code: MEDIA_STORAGE_ERROR.STORE_REFUSED,
      status: 403,
      message: /SignatureDoesNotMatch/,
    });
  });

  it('deletes a folder page by page, a thousand keys at a time, and nothing outside it', async () => {
    const inside = Array.from({ length: 2500 }, (_, i) => `p/a/${String(i).padStart(4, '0')}.webp`);
    seed([...inside, 'p/ab/next-door.webp', 'p/b/1.webp', 'p/a.webp']);

    await storageOf().deleteFolder('p/a');

    assert.deepEqual([...s3.buckets.get('media')!.keys()].sort(), [
      'p/a.webp',
      'p/ab/next-door.webp',
      'p/b/1.webp',
    ]);
    assert.deepEqual(s3.deleteBatches, [S3_MAX_KEYS, S3_MAX_KEYS, 500]);
    const listings = s3.requests.filter(({ method }) => method === HTTP_METHOD.GET);
    assert.deepEqual(
      listings.map(({ query }) => [
        query.get(S3_QUERY.PREFIX),
        query.get(S3_QUERY.MAX_KEYS),
        query.get(S3_QUERY.CONTINUATION_TOKEN),
      ]),
      [
        ['p/a/', String(S3_MAX_KEYS), null],
        ['p/a/', String(S3_MAX_KEYS), 'page+/=1'],
        ['p/a/', String(S3_MAX_KEYS), 'page+/=2'],
      ],
    );
  });

  it('deletes a folder of exactly one page in one listing and one batch', async () => {
    seed(Array.from({ length: S3_MAX_KEYS }, (_, i) => `p/a/${String(i).padStart(4, '0')}.webp`));

    await storageOf().deleteFolder('p/a');

    assert.equal(s3.buckets.get('media')!.size, 0);
    assert.deepEqual(s3.deleteBatches, [S3_MAX_KEYS]);
  });

  it('deletes the folders within the folder too', async () => {
    seed(['p/a/1.webp', 'p/a/thumbs/1.webp', 'p/a/thumbs/2026/1.webp']);

    await storageOf().deleteFolder('p/a');

    assert.equal(s3.buckets.get('media')!.size, 0);
  });

  it('deletes keys the XML has to escape', async () => {
    seed(['p/x/R&D.webp', 'p/x/<b>.webp', "p/x/it's.webp", 'p/x/"q".webp']);

    await storageOf().deleteFolder('p/x');

    assert.equal(s3.buckets.get('media')!.size, 0);
    assert.deepEqual(s3.deleteBatches, [4]);
  });

  it('takes an empty or missing folder for no failure', async () => {
    seed(['p/b/1.webp']);

    await storageOf().deleteFolder('p/none');

    assert.deepEqual(s3.deleteBatches, []);
    assert.equal(s3.requests.length, 1);
  });

  it('signs a link that opens a private object for its seconds, and not once it is changed', async () => {
    const storage = storageOf();
    await storage.put('private/x.jpg', Buffer.from('face'), 'image/jpeg');

    const link = await storage.signedUrlOf('private/x.jpg', 600);
    const opened = await fetch(link);
    assert.equal(opened.status, 200);
    assert.equal(await opened.text(), 'face');

    const longer = new URL(link);
    longer.searchParams.set(S3_QUERY.EXPIRES, '604800');
    for (const changed of [longer.toString(), link.replace('/x.jpg', '/y.jpg')]) {
      const refused = await fetch(changed);
      assert.equal(refused.status, 403);
      assert.match(await refused.text(), /SignatureDoesNotMatch/);
    }
    assert.equal((await fetch(storage.apiUrlOf('private/x.jpg'))).status, 403);
  });

  it('signs a link that stops working once its seconds are over', async (t) => {
    const storage = storageOf();
    await storage.put('private/x.jpg', Buffer.from('face'), 'image/jpeg');

    // Signed twenty minutes ago, for ten.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() - 20 * 60 * 1000 });
    const link = await storage.signedUrlOf('private/x.jpg', 10 * 60);
    t.mock.timers.reset();

    const refused = await fetch(link);
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /AccessDenied/);
  });

  it('sends any other request signed, its failures the same as the others', async () => {
    const storage = storageOf();
    await storage.put('p/a.webp', Buffer.from('pixels'), 'image/webp');

    const head = await storage.send(HTTP_METHOD.HEAD, 'p/a.webp');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '6');
    assert.equal(head.headers.get('content-type'), 'image/webp');
    await assert.rejects(storage.send(HTTP_METHOD.HEAD, 'p/none.webp'), MediaObjectMissingError);
    await assert.rejects(storage.send('PATCH', 'p/a.webp'), {
      ...failure(MEDIA_STORAGE_ERROR.STORE_REFUSED, 405),
      message: /to PATCH \/media\/p\/a\.webp:/,
    });
  });

  it('sends a request to the bucket itself, with its query, headers and body signed', async () => {
    const storage = storageOf();

    const put = await storage.send(HTTP_METHOD.PUT, 'notes/1.txt', {
      headers: { 'content-type': 'text/plain', 'x-amz-meta-author': 'katya' },
      body: 'hello',
    });
    const listing = await storage.send(HTTP_METHOD.GET, undefined, {
      query: { [S3_QUERY.LIST_TYPE]: '2', [S3_QUERY.PREFIX]: 'notes/' },
    });

    assert.equal(put.status, 200);
    assert.equal(s3.buckets.get('media')!.get('notes/1.txt')?.body.toString(), 'hello');
    assert.match(await listing.text(), /<Key>notes\/1\.txt<\/Key>/);
  });
});

describe('ensureBuckets', () => {
  beforeEach(() => s3.reset());

  const settings = () => ({
    endpoint,
    ...KEYS,
    region: 'us-east-1',
    publicBucket: 'app-test-media',
    privateBucket: 'app-test-private',
  });

  it('makes the buckets, the public one readable by anyone, and again is no failure', async () => {
    await ensureBuckets(settings());
    await ensureBuckets(settings());

    assert.deepEqual([...s3.buckets.keys()], ['app-test-media', 'app-test-private']);
    assert.deepEqual([...s3.policies.keys()], ['app-test-media']);
    assert.deepEqual(JSON.parse(s3.policies.get('app-test-media')!), {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: ['arn:aws:s3:::app-test-media/*'],
        },
      ],
    });
    assert.deepEqual(
      s3.requests
        .slice(0, 3)
        .map(
          ({ method, path, query }) =>
            `${method} ${path}${query.has(S3_QUERY.POLICY) ? '?policy' : ''}`,
        ),
      ['PUT /app-test-media', 'PUT /app-test-media?policy', 'PUT /app-test-private'],
    );
    assert.ok(s3.requests.every(({ region }) => region === 'us-east-1'));
  });

  it('makes only the bucket it is given', async () => {
    await ensureBuckets({ ...settings(), privateBucket: undefined });

    assert.deepEqual([...s3.buckets.keys()], ['app-test-media']);
  });

  it('makes a private bucket alone, with no policy', async () => {
    await ensureBuckets({ ...settings(), publicBucket: undefined });

    assert.deepEqual([...s3.buckets.keys()], ['app-test-private']);
    assert.deepEqual([...s3.policies.keys()], []);
  });

  it('asks nothing of the store when it is given no bucket', async () => {
    await ensureBuckets({ ...settings(), publicBucket: undefined, privateBucket: '' });

    assert.equal(s3.requests.length, 0);
  });

  it("signs for R2's region when it is given none", async () => {
    await ensureBuckets({ ...settings(), region: undefined });

    assert.ok(s3.requests.every(({ region }) => region === R2_REGION));
  });

  it("throws the store's refusal when it refuses", async () => {
    s3.state.refuse = refuseAll;

    await assert.rejects(ensureBuckets(settings()), {
      ...failure(MEDIA_STORAGE_ERROR.STORE_REFUSED, 403),
      message: /^The S3 store answered 403 to PUT \/app-test-media: .*AccessDenied/,
    });
  });

  it('throws a refusal of the policy, naming the request', async () => {
    s3.state.refuse = ({ query }) => query.has(S3_QUERY.POLICY);

    await assert.rejects(ensureBuckets(settings()), {
      ...failure(MEDIA_STORAGE_ERROR.STORE_REFUSED, 403),
      message: /to PUT \/app-test-media\?policy=: /,
    });
    assert.deepEqual([...s3.buckets.keys()], ['app-test-media']);
  });
});

import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

import { MEDIA_STORAGE_ERROR, MediaObjectMissingError, MediaStorageError } from './errors.ts';
import type { MediaStorage } from './media-storage.ts';
import {
  CHECKSUM,
  escapeXml,
  HEADER,
  HTTP_METHOD,
  HTTP_STATUS,
  LIST_OBJECTS_V2,
  R2_REGION,
  requestOf,
  S3_MAX_KEYS,
  S3_QUERY,
  S3_SERVICE,
  S3_XML,
  S3_XML_TAG,
  XML_CONTENT_TYPE,
  xmlElementOf,
  xmlValuesOf,
} from './s3-protocol.ts';
import { folderPrefixOf, joinedPath, withoutTrailingSlashes, withQuery } from './url.ts';

/** A year, in seconds: as long as a cache is ever asked to keep anything. */
const ONE_YEAR_SECONDS = 31_536_000;

/**
 * For objects that never change under their name — a new picture gets a new one — so a browser
 * and a CDN may keep them for good: `public, max-age=31536000, immutable`.
 */
export const IMMUTABLE_CACHE_CONTROL = `public, max-age=${ONE_YEAR_SECONDS}, immutable`;

/**
 * For objects only the person a link was signed for reads: their browser may keep them, a shared
 * cache (a CDN, a proxy) may not.
 */
export const PRIVATE_CACHE_CONTROL = 'private';

/** R2 is reached over HTTPS only. */
const R2_PROTOCOL = 'https://';
/** R2's S3 API: each account at a subdomain of this, and a jurisdiction's buckets one level in. */
const R2_S3_DOMAIN = 'r2.cloudflarestorage.com';
/** Between a host name's labels. */
const HOST_LABEL_SEPARATOR = '.';

/**
 * R2's S3 address: a bucket made with a jurisdiction (`eu`) is reached only at its own one — the
 * ordinary address answers it 403 AccessDenied, however right the token is.
 *
 * @param accountId The Cloudflare account's ID, from the dashboard's R2 page.
 * @param jurisdiction The jurisdiction the bucket was made in, such as `eu`; none by default.
 * @example
 * r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID));
 * // https://<account id>.r2.cloudflarestorage.com
 *
 * r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID), config.get(CONFIG.R2_JURISDICTION));
 * // https://<account id>.eu.r2.cloudflarestorage.com, for a bucket made in the EU
 */
export const r2EndpointOf = (accountId: string, jurisdiction = ''): string => {
  const labels = jurisdiction ? [accountId, jurisdiction, R2_S3_DOMAIN] : [accountId, R2_S3_DOMAIN];

  return `${R2_PROTOCOL}${labels.join(HOST_LABEL_SEPARATOR)}`;
};

/** An S3 API and the keys to it. */
export interface S3Connection {
  /**
   * The API's address, with no bucket in it: `r2EndpointOf(accountId)` for R2, the server's own
   * for a local store, such as `http://localhost:9000`.
   */
  endpoint: string;
  /** The region requests are signed for: `auto`, R2's, when left out or empty. */
  region?: string;
  /** The access key's ID: an R2 API token's, or a local store's user. */
  accessKeyId: string;
  /** The access key's secret. */
  secretAccessKey: string;
}

/** One bucket on an S3 API, and how its objects are read and cached. */
export interface S3StorageOptions extends S3Connection {
  /** The bucket's name. */
  bucket: string;
  /**
   * Where everyone reads the bucket's objects, such as the custom domain R2 serves it on:
   * `https://cdn.example.com`. A slash at the end is dropped. None, the default, for a private
   * bucket, whose objects are read only through the links `signedUrlOf()` makes.
   */
  publicUrl?: string;
  /**
   * The Cache-Control every object is put with: `IMMUTABLE_CACHE_CONTROL` for a public bucket whose
   * keys never change, `PRIVATE_CACHE_CONTROL` for a private one. None by default.
   */
  cacheControl?: string;
}

/** What a request carries besides its method and key. */
export interface S3RequestInit {
  /** Headers to send with it, in lower case; signed along with the request. */
  headers?: Record<string, string>;
  /** Its body, as fetch takes one. */
  body?: RequestInit['body'];
  /** The query, for a request to the bucket itself: a listing, a batch delete. */
  query?: Record<string, string>;
}

/** One page of ListObjectsV2, as much of it as deleting a folder needs. */
interface ListPage {
  /** The page's keys, unescaped. */
  keys: string[];
  /** Whether more pages follow. */
  isTruncated: boolean;
  /** The token the next page is asked for with; none on the last page. */
  nextContinuationToken?: string;
}

/**
 * A bucket in R2, through its S3 API; locally, an S3 store such as MinIO.
 *
 * Path-style requests signed with SigV4 (aws4fetch), which both speak. Anything but a
 * success throws: a missing object as MediaObjectMissingError, which will not change on a
 * retry, anything else as a MediaStorageError with the store's answer, which may.
 *
 * @example
 * // A public bucket on R2, served on the app's own domain:
 * const media = new S3Storage({
 *   endpoint: r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID)),
 *   accessKeyId: config.get(CONFIG.R2_ACCESS_KEY_ID),
 *   secretAccessKey: config.get(CONFIG.R2_SECRET_ACCESS_KEY),
 *   bucket: config.get(CONFIG.R2_BUCKET),
 *   publicUrl: config.get(CONFIG.MEDIA_PUBLIC_URL),
 *   cacheControl: IMMUTABLE_CACHE_CONTROL,
 * });
 *
 * const key = `${MEDIA_FOLDER.PHOTOS}/${randomUUID()}`;
 * await media.put(key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
 * media.urlOf(key); // https://cdn.example.com/photos/<uuid>
 */
export class S3Storage implements MediaStorage {
  /** Signs every request with the keys, for the region and for S3. */
  private readonly client: AwsClient;
  /** The S3 API's address, with no bucket in it. */
  private readonly endpoint: string;
  /** The bucket's name. */
  private readonly bucket: string;
  /** Where everyone reads the objects, without a slash at the end; empty for a private bucket. */
  private readonly publicUrl: string;
  /** The Cache-Control every object is put with; none when undefined. */
  private readonly cacheControl: string | undefined;

  /** @param options The API, its keys, the bucket and how its objects are read and cached. */
  public constructor(options: S3StorageOptions) {
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: S3_SERVICE,
      region: options.region || R2_REGION,
    });
    this.endpoint = options.endpoint;
    this.bucket = options.bucket;
    this.publicUrl = withoutTrailingSlashes(options.publicUrl ?? '');
    this.cacheControl = options.cacheControl;
  }

  /**
   * Without the keys there is no bucket to write to: false while either key is empty, for an app
   * that turns a feature off on a server with no storage set up.
   *
   * @example
   * const photosOn = media.configured;
   * if (!photosOn) {
   *   throw new ServiceUnavailableException();
   * }
   */
  public get configured(): boolean {
    return Boolean(this.client.accessKeyId && this.client.secretAccessKey);
  }

  /**
   * Stores the bytes under the key, replacing whatever was there, with the content type and the
   * store's Cache-Control.
   *
   * @throws {MediaStorageError} `STORE_REFUSED` when the store refuses; `OBJECT_MISSING` when the
   *   bucket is missing.
   * @example
   * await media.put(photo.key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
   */
  public async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const headers: Record<string, string> = { [HEADER.CONTENT_TYPE]: contentType };
    const cacheControl = this.cacheControl;
    if (cacheControl) {
      headers[HEADER.CACHE_CONTROL] = cacheControl;
    }

    await this.send(HTTP_METHOD.PUT, key, {
      headers,
      body: new Uint8Array(body),
    });
  }

  /**
   * The object's bytes.
   *
   * @throws {MediaObjectMissingError} `OBJECT_MISSING` when there is no such object, or no bucket.
   * @throws {MediaStorageError} `STORE_REFUSED` when the store refuses.
   * @example
   * const staged = await uploads.get(upload.key);
   */
  public async get(key: string): Promise<Buffer> {
    const response = await this.send(HTTP_METHOD.GET, key);

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Deletes the object. Deleting what is not there is not an error.
   *
   * @throws {MediaStorageError} `STORE_REFUSED` when the store refuses.
   * @example
   * await media.delete(photo.key); // one already gone is no failure
   */
  public async delete(key: string): Promise<void> {
    await this.send(HTTP_METHOD.DELETE, key).catch((error: unknown) => {
      const alreadyGone = error instanceof MediaObjectMissingError;
      if (!alreadyGone) {
        throw error;
      }
    });
  }

  /**
   * Deletes everything under `<folder>/`: listed page by page (up to a thousand keys each) and
   * deleted a page at a time. An empty or missing folder is no failure.
   *
   * @throws {MediaStorageError} `STORE_REFUSED` when the store refuses; `OBJECT_MISSING` when the
   *   bucket is missing.
   * @example
   * // Everything a closed account kept, in its own folder:
   * await media.deleteFolder(`${MEDIA_FOLDER.USERS}/${user.id}`);
   */
  public async deleteFolder(folder: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.listPage(folderPrefixOf(folder), token);
      if (page.keys.length) {
        await this.deleteObjects(page.keys);
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
  }

  /**
   * A link anyone holding it can GET the object with, for `seconds`, then never again: how a
   * private object is shown to the one person it is for, without the file passing through the API.
   * Signed here, with no request to the store.
   *
   * @param key The object's key.
   * @param seconds How long the link works, in seconds. S3 and R2 take a week at most.
   * @example
   * // How long a link to a private upload works: ten minutes, in seconds.
   * const UPLOAD_LINK_SECONDS = 600;
   *
   * const previewUrl = await uploads.signedUrlOf(upload.key, UPLOAD_LINK_SECONDS);
   */
  public async signedUrlOf(key: string, seconds: number): Promise<string> {
    const url = new URL(this.apiUrlOf(key));
    url.searchParams.set(S3_QUERY.EXPIRES, String(seconds));
    const signed = await this.client.sign(url.toString(), {
      method: HTTP_METHOD.GET,
      aws: { signQuery: true },
    });

    return signed.url;
  }

  /**
   * Where everyone reads the object: the bucket's public address and the key.
   *
   * @throws {MediaStorageError} `NO_PUBLIC_URL` for a private bucket, which has none.
   * @example
   * media.urlOf(photo.key); // https://cdn.example.com/photos/<id>
   */
  public urlOf(key: string): string {
    const isPublic = this.publicUrl.length > 0;
    if (!isPublic) {
      throw new MediaStorageError(MEDIA_STORAGE_ERROR.NO_PUBLIC_URL, this.bucket);
    }

    return joinedPath(this.publicUrl, key);
  }

  /**
   * The object's address on the S3 API, or the bucket's with no key: what a request is signed for.
   * Read without a signature, a private bucket's object answers 403.
   *
   * @example
   * uploads.apiUrlOf(upload.key); // https://<account id>.r2.cloudflarestorage.com/uploads/<id>
   */
  public apiUrlOf(key?: string): string {
    const base = joinedPath(this.endpoint, this.bucket);

    return key === undefined ? base : joinedPath(base, key);
  }

  /**
   * A signed request to the bucket itself or to one of its objects, for what the other methods do
   * not cover. Its failures are theirs: `OBJECT_MISSING` for a 404, `STORE_REFUSED` for anything
   * else but a success.
   *
   * @param method One of `HTTP_METHOD`, or any other method the S3 API takes.
   * @param key The object's key; none for a request to the bucket itself.
   * @param init The request's headers, body and query.
   * @returns The store's answer, a success.
   * @throws {MediaObjectMissingError} `OBJECT_MISSING` for a 404.
   * @throws {MediaStorageError} `STORE_REFUSED` for anything else but a success.
   * @example
   * // Whether an object is there, without downloading it:
   * const there = await media
   *   .send(HTTP_METHOD.HEAD, photo.key)
   *   .then(() => true)
   *   .catch((error: unknown) => {
   *     const missing = error instanceof MediaObjectMissingError;
   *     if (missing) {
   *       return false;
   *     }
   *     throw error;
   *   });
   */
  public async send(method: string, key?: string, init: S3RequestInit = {}): Promise<Response> {
    const { query, ...request } = init;
    const url = withQuery(this.apiUrlOf(key), query ?? {});
    const response = await this.client.fetch(url, { method, ...request });

    const path = key === undefined ? this.bucket : joinedPath(this.bucket, key);
    const missing = response.status === HTTP_STATUS.NOT_FOUND;
    if (missing) {
      throw new MediaObjectMissingError(path);
    }
    if (!response.ok) {
      throw new MediaStorageError(MEDIA_STORAGE_ERROR.STORE_REFUSED, requestOf(method, path), {
        status: response.status,
        text: await response.text(),
      });
    }

    return response;
  }

  /** A page of the keys under `prefix`: the first, or the one `token` points to. */
  private async listPage(prefix: string, token?: string): Promise<ListPage> {
    const query: Record<string, string> = {
      [S3_QUERY.LIST_TYPE]: LIST_OBJECTS_V2,
      [S3_QUERY.PREFIX]: prefix,
      [S3_QUERY.MAX_KEYS]: String(S3_MAX_KEYS),
    };
    if (token) {
      query[S3_QUERY.CONTINUATION_TOKEN] = token;
    }

    const response = await this.send(HTTP_METHOD.GET, undefined, { query });
    const xml = await response.text();

    return {
      keys: xmlValuesOf(xml, S3_XML_TAG.KEY),
      isTruncated: xmlValuesOf(xml, S3_XML_TAG.IS_TRUNCATED)[0] === S3_XML.TRUE,
      nextContinuationToken: xmlValuesOf(xml, S3_XML_TAG.NEXT_CONTINUATION_TOKEN)[0],
    };
  }

  /**
   * Up to a thousand keys in one DeleteObjects. Quiet: the answer names only the keys that could
   * not be deleted, and it is not read.
   */
  private async deleteObjects(keys: string[]): Promise<void> {
    const objects = keys
      .map((key) => xmlElementOf(S3_XML_TAG.OBJECT, xmlElementOf(S3_XML_TAG.KEY, escapeXml(key))))
      .join('');
    const quiet = xmlElementOf(S3_XML_TAG.QUIET, S3_XML.TRUE);
    const body =
      S3_XML.DECLARATION +
      xmlElementOf(S3_XML_TAG.DELETE, `${quiet}${objects}`, S3_XML.NAMESPACE_ATTRIBUTE);

    await this.send(HTTP_METHOD.POST, undefined, {
      query: { [S3_QUERY.DELETE]: '' },
      headers: {
        [HEADER.CONTENT_TYPE]: XML_CONTENT_TYPE,
        // S3 takes a batch delete only with its body's checksum.
        [HEADER.CONTENT_MD5]: createHash(CHECKSUM.ALGORITHM).update(body).digest(CHECKSUM.ENCODING),
      },
      body,
    });
  }
}

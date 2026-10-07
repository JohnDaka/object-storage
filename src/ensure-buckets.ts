import { AwsClient } from 'aws4fetch';

import { MEDIA_STORAGE_ERROR, MediaStorageError } from './errors.ts';
import {
  HTTP_METHOD,
  HTTP_STATUS,
  PUBLIC_READ_POLICY,
  R2_REGION,
  requestOf,
  S3_QUERY,
  S3_SERVICE,
} from './s3-protocol.ts';
import type { S3Connection } from './s3-storage.ts';
import { joinedPath, withQuery } from './url.ts';

/** A local S3 store, and the buckets to make on it. Each bucket is made only when it is named. */
export interface StorageSettings extends S3Connection {
  /** Readable by anyone, the way R2 serves a bucket on a custom domain. None by default. */
  publicBucket?: string;
  /** Read by nobody but through the links the keys' holder signs. None by default. */
  privateBucket?: string;
}

/** The policy that lets anyone read the bucket's objects, and nothing else: no listing, no writing. */
const publicReadPolicy = (bucket: string): string =>
  JSON.stringify({
    Version: PUBLIC_READ_POLICY.VERSION,
    Statement: [
      {
        Effect: PUBLIC_READ_POLICY.EFFECT,
        Principal: { AWS: [PUBLIC_READ_POLICY.PRINCIPAL] },
        Action: [PUBLIC_READ_POLICY.ACTION],
        Resource: [
          `${PUBLIC_READ_POLICY.BUCKET_ARN_PREFIX}${bucket}${PUBLIC_READ_POLICY.EVERY_OBJECT}`,
        ],
      },
    ],
  });

/**
 * Creates the media buckets on a local S3 store (MinIO, for one), for development and tests:
 * a dev script runs it, and so does the tests' global setup, with buckets of their own.
 *
 * The public one gets a policy that lets anyone read its objects, which is what R2 does for a
 * bucket served on a custom domain; the private one gets none — its objects are read only through
 * links the API signs. Safe to run again. Not for R2 itself: there the buckets and the public one's
 * domain are made in the Cloudflare dashboard.
 *
 * @throws {MediaStorageError} `STORE_REFUSED` when the store refuses a bucket or the policy; a
 *   bucket that is there already, and the keys' own, is no failure.
 * @example
 * // The tests' global setup: buckets of their own, so a test run never touches the dev data.
 * await ensureBuckets({
 *   endpoint: config.get(CONFIG.S3_ENDPOINT),
 *   region: config.get(CONFIG.S3_REGION),
 *   accessKeyId: config.get(CONFIG.S3_ACCESS_KEY_ID),
 *   secretAccessKey: config.get(CONFIG.S3_SECRET_ACCESS_KEY),
 *   publicBucket: config.get(CONFIG.TEST_PUBLIC_BUCKET),
 *   privateBucket: config.get(CONFIG.TEST_PRIVATE_BUCKET),
 * });
 */
export const ensureBuckets = async (settings: StorageSettings): Promise<void> => {
  const client = new AwsClient({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    service: S3_SERVICE,
    region: settings.region || R2_REGION,
  });
  const send = async (method: HTTP_METHOD, path: string, body?: string) => {
    const response = await client.fetch(joinedPath(settings.endpoint, path), {
      method,
      body,
    });
    // The bucket is there already, and ours.
    const alreadyThere = response.status === HTTP_STATUS.CONFLICT;
    if (!response.ok && !alreadyThere) {
      throw new MediaStorageError(MEDIA_STORAGE_ERROR.STORE_REFUSED, requestOf(method, path), {
        status: response.status,
        text: await response.text(),
      });
    }
  };

  const { publicBucket, privateBucket } = settings;
  if (publicBucket) {
    await send(HTTP_METHOD.PUT, publicBucket);
    await send(
      HTTP_METHOD.PUT,
      withQuery(publicBucket, { [S3_QUERY.POLICY]: '' }),
      publicReadPolicy(publicBucket),
    );
  }
  if (privateBucket) {
    await send(HTTP_METHOD.PUT, privateBucket);
  }
};

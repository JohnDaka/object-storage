import { isString } from './guards.ts';
import { folderPrefixOf } from './url.ts';

/**
 * Where the objects' bytes live: put, read and delete by key, a whole folder at once, and the
 * address each key is read from.
 *
 * Two stores keep to it: `S3Storage`, a bucket on R2 or any other S3 API, and `LocalStorage`, a
 * folder of this machine's for development and the tests. The app picks one by its configuration,
 * and the code that stores things never knows which.
 *
 * @example
 * // Where the API serves the local folder itself, under its own prefix.
 * const LOCAL_MEDIA_ROUTE = '/api/v1/media';
 *
 * // R2 when it is configured, the local folder otherwise:
 * const storage: MediaStorage = config.get(CONFIG.R2_ACCOUNT_ID)
 *   ? new S3Storage({
 *       endpoint: r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID)),
 *       accessKeyId: config.get(CONFIG.R2_ACCESS_KEY_ID),
 *       secretAccessKey: config.get(CONFIG.R2_SECRET_ACCESS_KEY),
 *       bucket: config.get(CONFIG.R2_BUCKET),
 *       publicUrl: config.get(CONFIG.MEDIA_PUBLIC_URL),
 *       cacheControl: IMMUTABLE_CACHE_CONTROL,
 *     })
 *   : new LocalStorage({ dir: config.get(CONFIG.MEDIA_DIR), publicUrl: LOCAL_MEDIA_ROUTE });
 */
export interface MediaStorage {
  /**
   * Stores the bytes under the key, replacing whatever was there.
   *
   * @param key Where, such as `photos/<id>`. It goes into the address as it is: keep it to
   *   URL-safe characters.
   * @param body The bytes.
   * @param contentType What they are, as the object is served. A local folder does not keep it.
   * @throws {MediaStorageError} `STORE_REFUSED` when an S3 store refuses; `KEY_OUTSIDE_FOLDER` for
   *   a key that would leave a local folder.
   */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * The object's bytes.
   *
   * @throws {MediaObjectMissingError} `OBJECT_MISSING` when there is none.
   * @throws {MediaStorageError} `STORE_REFUSED` when an S3 store refuses; `KEY_OUTSIDE_FOLDER` for
   *   a key that would leave a local folder.
   */
  get(key: string): Promise<Buffer>;
  /**
   * Deletes the object. Deleting what is not there is not an error: the result is the same.
   *
   * @throws {MediaStorageError} `STORE_REFUSED` when an S3 store refuses; `KEY_OUTSIDE_FOLDER` for
   *   a key that would leave a local folder.
   */
  delete(key: string): Promise<void>;
  /**
   * Deletes everything under `<folder>/`, at any depth. An empty or missing folder is no failure.
   *
   * @throws {MediaStorageError} `STORE_REFUSED` when an S3 store refuses; `OBJECT_MISSING` when
   *   its bucket is missing; `KEY_OUTSIDE_FOLDER` for a folder that would leave a local one.
   */
  deleteFolder(folder: string): Promise<void>;
  /**
   * Where everyone reads the object: the store's public address and the key, never its API.
   *
   * @throws {MediaStorageError} `NO_PUBLIC_URL` for a private bucket, which has no public address.
   */
  urlOf(key: string): string;
}

/**
 * The key behind a public address, when the address is one of the storage's in `folder`; null
 * for anything else — a sign-in provider's picture, a generated default, another folder.
 *
 * For deleting an old file only when it is the app's own: a profile's picture may be one the app
 * stored, or one a sign-in provider gave, and only the first is the app's to delete.
 *
 * @param storage The store whose addresses are recognised: anything with its `urlOf()`.
 * @param folder The folder the key must be in, without a slash at the end.
 * @param url The address, or null for none.
 * @example
 * // A new avatar replaces the old one, which is deleted only when it is one of ours:
 * const oldKey = publicKeyIn(media, MEDIA_FOLDER.AVATARS, user.avatarUrl);
 * if (oldKey) {
 *   await media.delete(oldKey);
 * }
 */
export const publicKeyIn = (
  storage: Pick<MediaStorage, 'urlOf'>,
  folder: string,
  url: string | null,
): string | null => {
  const prefix = storage.urlOf(folderPrefixOf(folder));
  const ours = isString(url) && url.startsWith(prefix);

  return ours ? url.slice(storage.urlOf('').length) : null;
};

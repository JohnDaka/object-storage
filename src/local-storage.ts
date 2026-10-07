import { dirname, join, resolve, sep } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { MEDIA_STORAGE_ERROR, MediaObjectMissingError, MediaStorageError } from './errors.ts';
import type { MediaStorage } from './media-storage.ts';
import { joinedPath, withoutTrailingSlashes } from './url.ts';

/** Node's codes for the file system's failures told apart from any other. */
const FS_ERROR = {
  /** No such file or folder. */
  NO_ENTRY: 'ENOENT',
} as const;

/** A folder of this machine's, and where the app serves it. */
export interface LocalStorageOptions {
  /** The folder, absolute or from the working directory. Its subfolders are made as they are needed. */
  dir: string;
  /**
   * Where the app serves the folder: a path on its own origin, such as `/api/v1/media`, or a whole
   * address. A slash at the end is dropped.
   */
  publicUrl: string;
}

/**
 * A folder of this machine's, for development and the tests: the app serves it itself at
 * `publicUrl` (a static route), so what is put in it shows without any bucket at all.
 *
 * @example
 * // Where the API serves the local folder itself, under its own prefix.
 * const LOCAL_MEDIA_ROUTE = '/api/v1/media';
 *
 * const media = new LocalStorage({ dir: config.get(CONFIG.MEDIA_DIR), publicUrl: LOCAL_MEDIA_ROUTE });
 * // main.ts serves it: app.useStaticAssets(resolve(config.get(CONFIG.MEDIA_DIR)), { prefix: LOCAL_MEDIA_ROUTE });
 *
 * await media.put(photo.key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
 * media.urlOf(photo.key); // /api/v1/media/photos/<id>
 */
export class LocalStorage implements MediaStorage {
  /** The folder, as an absolute path: every key resolves under it. */
  private readonly root: string;
  /** Where the app serves the folder, without a slash at the end. */
  private readonly publicUrl: string;

  /** @param options The folder, and where the app serves it. */
  public constructor(options: LocalStorageOptions) {
    this.root = resolve(options.dir);
    this.publicUrl = withoutTrailingSlashes(options.publicUrl);
  }

  /**
   * Writes the bytes to the key's file, making its folders, and replaces whatever was there. The
   * type is not kept: the static route tells it by the file's name.
   *
   * @throws {MediaStorageError} `KEY_OUTSIDE_FOLDER` for a key that would land outside the folder,
   *   or on the folder itself.
   * @example
   * await media.put(photo.key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
   */
  public async put(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  /**
   * The key's file, read. Any failure but a missing file, such as a key that names a folder, is the
   * file system's own error.
   *
   * @throws {MediaObjectMissingError} `OBJECT_MISSING` when there is no such file.
   * @throws {MediaStorageError} `KEY_OUTSIDE_FOLDER` for a key that would land outside the folder.
   * @example
   * const staged = await media.get(upload.key);
   */
  public async get(key: string): Promise<Buffer> {
    const path = this.pathOf(key);

    return await readFile(path).catch((error: NodeJS.ErrnoException) => {
      const missing = error.code === FS_ERROR.NO_ENTRY;
      if (missing) {
        throw new MediaObjectMissingError(key);
      }
      throw error;
    });
  }

  /**
   * Deletes the key's file; one that is not there is no failure.
   *
   * @throws {MediaStorageError} `KEY_OUTSIDE_FOLDER` for a key that would land outside the folder.
   * @example
   * await media.delete(photo.key);
   */
  public async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  /**
   * Deletes the folder and everything in it; a missing one is no failure. The store's own folder
   * is never one of them: an empty name is refused.
   *
   * @throws {MediaStorageError} `KEY_OUTSIDE_FOLDER` for a folder outside the store's, or the
   *   store's own.
   * @example
   * await media.deleteFolder(`${MEDIA_FOLDER.USERS}/${user.id}`);
   */
  public async deleteFolder(folder: string): Promise<void> {
    await rm(this.pathOf(folder), { recursive: true, force: true });
  }

  /**
   * Where the app serves the key's file.
   *
   * @example
   * media.urlOf(photo.key); // /api/v1/media/photos/<id>
   */
  public urlOf(key: string): string {
    return joinedPath(this.publicUrl, key);
  }

  /**
   * The keys are the app's own, but a path is never built from one unchecked. Inside means under
   * the folder: neither the folder itself nor a neighbour whose name merely starts the same.
   */
  private pathOf(key: string): string {
    const path = resolve(join(this.root, key));
    const inside = path.startsWith(`${this.root}${sep}`);
    if (!inside) {
      throw new MediaStorageError(MEDIA_STORAGE_ERROR.KEY_OUTSIDE_FOLDER, key);
    }
    return path;
  }
}

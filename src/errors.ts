/**
 * Why a store failed a call: the `code` of every `MediaStorageError`, so a caller tells the
 * failures apart without reading their messages.
 */
export const MEDIA_STORAGE_ERROR = {
  /**
   * The object is not there: a deleted upload, or a file that never arrived. For an S3 store, a
   * missing bucket too, which answers with the same 404. A retry will not change that. Thrown as a
   * `MediaObjectMissingError`.
   */
  OBJECT_MISSING: 'OBJECT_MISSING',
  /**
   * The S3 store answered with anything but a success, a 404 aside: its keys, its rights, its
   * network. `status` has the HTTP status and the message has the store's own answer. A retry may
   * change that.
   */
  STORE_REFUSED: 'STORE_REFUSED',
  /**
   * `LocalStorage` was given a key that would land outside its folder, or on the folder itself,
   * such as `../x` or an empty key. Nothing on disk was touched.
   */
  KEY_OUTSIDE_FOLDER: 'KEY_OUTSIDE_FOLDER',
  /**
   * `urlOf()` was asked of a bucket with no `publicUrl`: a private one, whose objects are read
   * through `signedUrlOf()`.
   */
  NO_PUBLIC_URL: 'NO_PUBLIC_URL',
} as const;
/** One of `MEDIA_STORAGE_ERROR`'s codes. */
export type MEDIA_STORAGE_ERROR = (typeof MEDIA_STORAGE_ERROR)[keyof typeof MEDIA_STORAGE_ERROR];

/** What an S3 store answered a request it refused. */
export interface StoreAnswer {
  /** The HTTP status: 403 for a token without the right to the bucket, 5xx for the store's own trouble. */
  status: number;
  /** The answer's body: S3's XML error, whose `Code` names the reason, such as `AccessDenied`. */
  text: string;
}

/**
 * What each failure says, given what it happened to: the object's path, the request, the key, the
 * bucket. A refusal says what the store answered too.
 */
const MESSAGE: Record<MEDIA_STORAGE_ERROR, (where: string, answer?: StoreAnswer) => string> = {
  [MEDIA_STORAGE_ERROR.OBJECT_MISSING]: (where) => `No object at ${where}`,
  [MEDIA_STORAGE_ERROR.STORE_REFUSED]: (where, answer) =>
    `The S3 store answered ${answer?.status} to ${where}: ${answer?.text}`,
  [MEDIA_STORAGE_ERROR.KEY_OUTSIDE_FOLDER]: (where) => `A media key outside the folder: ${where}`,
  [MEDIA_STORAGE_ERROR.NO_PUBLIC_URL]: (where) =>
    `The bucket ${where} has no publicUrl: its objects are read through signedUrlOf`,
};

/**
 * A store's failure, its `code` telling which: one of `MEDIA_STORAGE_ERROR`. For a refusal,
 * `status` is the HTTP status the store answered with, and its whole answer is in the message.
 *
 * @example
 * // A store that is down is the server's trouble, not the uploader's: a 503, not a 500.
 * const isRefusal = (error: unknown): error is MediaStorageError =>
 *   error instanceof MediaStorageError && error.code === MEDIA_STORAGE_ERROR.STORE_REFUSED;
 *
 * await media.put(key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]).catch((error: unknown) => {
 *   const refused = isRefusal(error);
 *   if (refused) {
 *     throw new ServiceUnavailableException();
 *   }
 *   throw error;
 * });
 */
export class MediaStorageError extends Error {
  /** Which failure it is. */
  public readonly code: MEDIA_STORAGE_ERROR;
  /** The HTTP status an S3 store refused the request with; none for any other failure. */
  public readonly status?: number;

  /**
   * @param code Which failure.
   * @param where What it happened to, for the message: the object's path, the request, the key
   *   or the bucket.
   * @param answer What the store answered, for a refusal.
   */
  public constructor(code: MEDIA_STORAGE_ERROR, where = '', answer?: StoreAnswer) {
    super(MESSAGE[code](where, answer));
    this.name = MediaStorageError.name;
    this.code = code;
    this.status = answer?.status;
  }
}

/**
 * The object is not there: a deleted upload, or a file that never arrived. Its `code` is
 * `OBJECT_MISSING`, and being a `MediaStorageError` as well, it is caught with the others.
 *
 * @example
 * // A staging copy swept away before it was used: the uploader sends it again.
 * const bytes = await uploads.get(key).catch((error: unknown) => {
 *   const gone = error instanceof MediaObjectMissingError;
 *   if (gone) {
 *     throw new GoneException();
 *   }
 *   throw error;
 * });
 */
export class MediaObjectMissingError extends MediaStorageError {
  /** @param where The object's path: `<bucket>/<key>` for an S3 store, the key for a local folder. */
  public constructor(where: string) {
    super(MEDIA_STORAGE_ERROR.OBJECT_MISSING, where);
    this.name = MediaObjectMissingError.name;
  }
}

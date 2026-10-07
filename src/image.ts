import type { FailOnOptions, ResizeOptions, SharpConstructor } from 'sharp';

// sharp's CommonJS entry is the function itself, while the types it publishes describe its
// ES module (a default export), which is what TypeScript picks under this package's settings.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment -- see above
const sharp: SharpConstructor = require('sharp');

/** How many libvips threads decode one image under `tuneSharpForUploads()`. */
const THREADS_PER_IMAGE = 1;

/**
 * Tunes sharp, for the whole process, for a server that decodes one stranger's upload after
 * another: one libvips thread per image, so a large upload takes one core rather than all of
 * them; and no operation cache, since no upload is ever decoded twice. Call it once at boot.
 *
 * Not done on import: sharp's settings belong to the app, and importing a library should not
 * change them behind its back.
 *
 * @example
 * // main.ts, before the app takes its first upload:
 * tuneSharpForUploads();
 */
export const tuneSharpForUploads = (): void => {
  sharp.concurrency(THREADS_PER_IMAGE);
  sharp.cache(false);
};

/** Image formats, as sharp names them: what `inputFormats` lists. */
export const IMAGE_FORMAT = {
  /** JPEG: what phone cameras write. */
  JPEG: 'jpeg',
  /** PNG: screenshots and drawings. */
  PNG: 'png',
  /** WebP: what browsers show smallest. */
  WEBP: 'webp',
} as const;
/** One of `IMAGE_FORMAT`'s formats. */
export type IMAGE_FORMAT = (typeof IMAGE_FORMAT)[keyof typeof IMAGE_FORMAT];

/** What an image is stored as. WebP unless something that shows it cannot read WebP. */
export const STORED_FORMAT = {
  /** WebP: smaller than JPEG at the same quality, and every browser shows it. The default. */
  WEBP: IMAGE_FORMAT.WEBP,
  /** JPEG: for what cannot show WebP, such as some share-card renderers and email clients. */
  JPEG: IMAGE_FORMAT.JPEG,
} as const;
/** One of `STORED_FORMAT`'s formats. */
export type STORED_FORMAT = (typeof STORED_FORMAT)[keyof typeof STORED_FORMAT];

/** The content type a stored image is put with, by its format. */
export const IMAGE_CONTENT_TYPE = {
  /** A WebP image's. */
  [STORED_FORMAT.WEBP]: 'image/webp',
  /** A JPEG image's. */
  [STORED_FORMAT.JPEG]: 'image/jpeg',
} as const satisfies Record<STORED_FORMAT, string>;

/** How damaged pixel data may be before sharp gives up, from the least strict to the most. */
export const FAIL_ON = {
  /** Never: whatever can be decoded is, and the rest is left blank. */
  NONE: 'none',
  /** On a file cut off before its end. */
  TRUNCATED: 'truncated',
  /** On damaged pixel data, a cut-off file included. The default here. */
  ERROR: 'error',
  /** On anything libvips warns of: the strictest, and sharp's own default. */
  WARNING: 'warning',
} as const satisfies Record<string, FailOnOptions>;
/** One of `FAIL_ON`'s levels. */
export type FAIL_ON = (typeof FAIL_ON)[keyof typeof FAIL_ON];

/**
 * What `toStoredImage()` does unless told otherwise: settings for photos people upload, to be shown
 * in a browser.
 */
export const IMAGE_DEFAULTS = {
  /** The longer side as stored, in pixels; a smaller image keeps its size. */
  MAX_EDGE: 2048,
  /** What an image is stored as. */
  FORMAT: STORED_FORMAT.WEBP,
  /** WebP's quality, in percent. */
  WEBP_QUALITY: 82,
  /** JPEG's quality, in percent. */
  JPEG_QUALITY: 85,
  /** The formats taken, read from the bytes. Anything else is refused, not converted. */
  INPUT_FORMATS: [IMAGE_FORMAT.JPEG, IMAGE_FORMAT.PNG, IMAGE_FORMAT.WEBP],
  /**
   * The most pixels (width × height) a decoded image may have. A larger one is refused before it
   * is decoded: a small file can unpack huge.
   */
  MAX_INPUT_PIXELS: 40_000_000,
  /** How damaged pixel data may be before sharp gives up. */
  FAIL_ON: FAIL_ON.ERROR,
} as const;

/** An image as it is stored. */
export interface StoredImage {
  /** The image, re-encoded: only its pixels. */
  data: Buffer;
  /** Its width as stored, in pixels. */
  width: number;
  /** Its height as stored, in pixels. */
  height: number;
}

/** How `toStoredImage()` takes and stores an image: each option leaves its default when left out. */
export interface ImageOptions {
  /**
   * How the image is fitted, as sharp's `resize` takes it. By default no larger than
   * `IMAGE_DEFAULTS.MAX_EDGE` (2048 px) on its longer side, keeping its shape, and a smaller image
   * keeps its size.
   */
  resize?: ResizeOptions;
  /** What it is stored as: `STORED_FORMAT.WEBP` by default. */
  format?: STORED_FORMAT;
  /**
   * The encoder's quality, in percent: `IMAGE_DEFAULTS.WEBP_QUALITY` (82) for WebP and
   * `IMAGE_DEFAULTS.JPEG_QUALITY` (85) for JPEG by default.
   */
  quality?: number;
  /**
   * The formats taken, as `IMAGE_FORMAT` names them, read from the bytes:
   * `IMAGE_DEFAULTS.INPUT_FORMATS` (JPEG, PNG and WebP) by default. Null takes whatever sharp can
   * read.
   */
  inputFormats?: readonly string[] | null;
  /**
   * The most pixels (width × height) a decoded image may have: `IMAGE_DEFAULTS.MAX_INPUT_PIXELS`
   * (40 million) by default. `true` is sharp's own limit, `false` none.
   */
  maxInputPixels?: number | boolean;
  /**
   * How damaged pixel data may be before sharp gives up, as its `failOn`: `FAIL_ON.ERROR` by
   * default.
   */
  failOn?: FAIL_ON;
}

/** Why an image was refused: the `code` of every `UnsupportedImageError`. */
export const IMAGE_ERROR = {
  /** Not an image sharp will open: not an image at all, an empty file, or one over the pixel limit. */
  NOT_AN_IMAGE: 'NOT_AN_IMAGE',
  /** An image, of a format not taken. */
  FORMAT_NOT_TAKEN: 'FORMAT_NOT_TAKEN',
  /** Its header was read but not its pixels: a damaged or cut-off file. */
  UNREADABLE: 'UNREADABLE',
} as const;
/** One of `IMAGE_ERROR`'s codes. */
export type IMAGE_ERROR = (typeof IMAGE_ERROR)[keyof typeof IMAGE_ERROR];

/** What each refusal says, given the image's format where it matters. */
const MESSAGE: Record<IMAGE_ERROR, (format: string) => string> = {
  [IMAGE_ERROR.NOT_AN_IMAGE]: () => 'Not an image',
  [IMAGE_ERROR.FORMAT_NOT_TAKEN]: (format) => `Images of type ${format} are not taken`,
  [IMAGE_ERROR.UNREADABLE]: () => 'The image could not be read',
};

/**
 * Not an image, or not one of the formats taken: its `code` tells which, one of `IMAGE_ERROR`, and
 * sharp's own error, if any, is its `cause`. Always the uploader's mistake, never the server's.
 *
 * @example
 * const image = await toStoredImage(upload.buffer).catch((error: unknown) => {
 *   const refused = error instanceof UnsupportedImageError;
 *   if (refused) {
 *     throw new UnsupportedMediaTypeException();
 *   }
 *   throw error;
 * });
 */
export class UnsupportedImageError extends Error {
  /** Why the image was refused. */
  public readonly code: IMAGE_ERROR;

  /**
   * @param code Why the image was refused.
   * @param format The image's format as sharp names it, for the message; none when it was not read.
   * @param cause sharp's own error, if any.
   */
  public constructor(code: IMAGE_ERROR, format = '', cause?: unknown) {
    super(MESSAGE[code](format), { cause });
    this.name = UnsupportedImageError.name;
    this.code = code;
  }
}

/**
 * An image as it will be stored: decoded, turned upright by its EXIF orientation, resized,
 * and re-encoded as WebP (or JPEG, when asked).
 *
 * Re-encoding is the point, not a side effect. What is stored is only pixels: no EXIF, so no
 * GPS position from a phone camera, no camera serial, no embedded thumbnail that might show
 * something the crop does not. The format is read from the bytes, never from the file name
 * or the type the client claimed.
 *
 * @param input The uploaded file's bytes.
 * @param options How it is taken and stored; see `ImageOptions` and `IMAGE_DEFAULTS`.
 * @returns The image as stored, with its size.
 * @throws {UnsupportedImageError} `NOT_AN_IMAGE` for bytes that are no image (an empty file
 *   included), or one over the pixel limit; `FORMAT_NOT_TAKEN` for an image of a format not taken; `UNREADABLE` for one whose
 *   header reads but whose pixels do not.
 * @example
 * // A photo as people upload it: WebP, at most 2048 px on its longer side.
 * const image = await toStoredImage(upload.buffer);
 * await media.put(photo.key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
 *
 * @example
 * import { fit } from 'sharp';
 *
 * // An avatar's side, in pixels.
 * const AVATAR_SIDE = 400;
 *
 * // Exactly that square, cropped from the centre, as JPEG for the emails it goes into:
 * const avatar = await toStoredImage(upload.buffer, {
 *   resize: { width: AVATAR_SIDE, height: AVATAR_SIDE, fit: fit.cover },
 *   format: STORED_FORMAT.JPEG,
 * });
 */
export const toStoredImage = async (
  input: Buffer,
  options: ImageOptions = {},
): Promise<StoredImage> => {
  const {
    resize = {
      width: IMAGE_DEFAULTS.MAX_EDGE,
      height: IMAGE_DEFAULTS.MAX_EDGE,
      fit: sharp.fit.inside,
      withoutEnlargement: true,
    },
    format = IMAGE_DEFAULTS.FORMAT,
    quality = format === STORED_FORMAT.JPEG
      ? IMAGE_DEFAULTS.JPEG_QUALITY
      : IMAGE_DEFAULTS.WEBP_QUALITY,
    inputFormats = IMAGE_DEFAULTS.INPUT_FORMATS,
    maxInputPixels = IMAGE_DEFAULTS.MAX_INPUT_PIXELS,
    failOn = IMAGE_DEFAULTS.FAIL_ON,
  } = options;
  // An empty file is no image either. sharp throws on one as soon as it is given it, before it is
  // asked anything, and so outside the refusals below.
  const empty = input.length === 0;
  if (empty) {
    throw new UnsupportedImageError(IMAGE_ERROR.NOT_AN_IMAGE);
  }
  const decoder = sharp(input, {
    failOn,
    limitInputPixels: maxInputPixels,
  });

  const { format: inputFormat } = await decoder.metadata().catch((cause: unknown) => {
    throw new UnsupportedImageError(IMAGE_ERROR.NOT_AN_IMAGE, '', cause);
  });
  const taken = inputFormats === null || inputFormats.includes(inputFormat);
  if (!taken) {
    throw new UnsupportedImageError(IMAGE_ERROR.FORMAT_NOT_TAKEN, inputFormat);
  }

  const { data, info } = await decoder
    .rotate()
    .resize(resize)
    .toFormat(format, { quality })
    .toBuffer({ resolveWithObject: true })
    .catch((cause: unknown) => {
      throw new UnsupportedImageError(IMAGE_ERROR.UNREADABLE, inputFormat, cause);
    });

  return { data, width: info.width, height: info.height };
};

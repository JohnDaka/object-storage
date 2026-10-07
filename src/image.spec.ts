import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, describe, it } from 'node:test';

import type { SharpConstructor } from 'sharp';

// The module takes sharp with `require`, as it runs once built: CommonJS. Node runs its TypeScript
// here as an ES module, which has no `require` of its own, so the spec lends it one before the
// module is loaded. The type check takes the package's CommonJS, which has no `import.meta`.
// @ts-expect-error -- Node runs the spec as an ES module, which has it.
const requireHere = createRequire(import.meta.url);
(globalThis as { require?: NodeJS.Require }).require = requireHere;
const sharp = requireHere('sharp') as SharpConstructor;

/** sharp's threads per image as the process starts: one per core, sharp's own default. */
const defaultThreads = sharp.concurrency();

let image: typeof import('./image.ts');
before(async () => {
  image = await import('./image.ts');
});

const canvas = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: '#3b82f6' },
  });

/** How `toStoredImage` refused, by its code. */
const refusedAs = (code: string) => ({ name: image.UnsupportedImageError.name, code });

/** A photo cut off after its header: readable as an image, not as pixels. */
const cutOffPhoto = async (): Promise<Buffer> =>
  (await canvas(300, 300).jpeg().toBuffer()).subarray(0, 600);

describe('@dakaio/object-storage/image', () => {
  it('exports what its README lists, and nothing else', () => {
    assert.deepEqual(Object.keys(image).sort(), [
      'FAIL_ON',
      'IMAGE_CONTENT_TYPE',
      'IMAGE_DEFAULTS',
      'IMAGE_ERROR',
      'IMAGE_FORMAT',
      'STORED_FORMAT',
      'UnsupportedImageError',
      'toStoredImage',
      'tuneSharpForUploads',
    ]);
  });

  it('names every format as sharp does, and gives each stored one its content type', () => {
    for (const format of Object.values(image.IMAGE_FORMAT)) {
      assert.ok(sharp.format[format], format);
    }
    assert.deepEqual(image.IMAGE_CONTENT_TYPE, {
      [image.STORED_FORMAT.WEBP]: 'image/webp',
      [image.STORED_FORMAT.JPEG]: 'image/jpeg',
    });
  });

  it('names every failOn level sharp takes', async () => {
    const photo = await canvas(10, 10).png().toBuffer();

    for (const failOn of Object.values(image.FAIL_ON)) {
      await image.toStoredImage(photo, { failOn });
    }
  });

  it('has a code for each refusal, its own name', () => {
    assert.deepEqual(Object.keys(image.IMAGE_ERROR), Object.values(image.IMAGE_ERROR));
  });
});

describe('an uploaded image, as stored', () => {
  it('keeps no EXIF: no GPS position, no camera details', async () => {
    const photo = await canvas(640, 480)
      .jpeg()
      .withExif({
        IFD0: { Artist: 'someone', Model: 'Phone 15' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '55/1 45/1 0/1' },
      })
      .toBuffer();
    assert.ok((await sharp(photo).metadata()).exif);

    const { data } = await image.toStoredImage(photo);
    const stored = await sharp(data).metadata();

    assert.equal(stored.exif, undefined);
    assert.equal(data.includes(Buffer.from('Phone 15')), false);
    assert.equal(data.includes(Buffer.from('someone')), false);
  });

  it('is WebP, whatever it came as', async () => {
    for (const input of [
      await canvas(10, 10).png().toBuffer(),
      await canvas(10, 10).jpeg().toBuffer(),
      await canvas(10, 10).webp().toBuffer(),
    ]) {
      const { data } = await image.toStoredImage(input);
      assert.equal((await sharp(data).metadata()).format, image.IMAGE_DEFAULTS.FORMAT);
    }
  });

  it("is encoded at WebP's default quality", async () => {
    const photo = await canvas(64, 48).png().toBuffer();

    const stored = await image.toStoredImage(photo);
    const atDefault = await image.toStoredImage(photo, {
      quality: image.IMAGE_DEFAULTS.WEBP_QUALITY,
    });
    const atAnother = await image.toStoredImage(photo, { quality: 10 });

    assert.ok(stored.data.equals(atDefault.data));
    assert.ok(!stored.data.equals(atAnother.data));
  });

  it('fits a large image within the default edge on its longer side, keeping its shape', async () => {
    const stored = await image.toStoredImage(await canvas(4000, 2000).jpeg().toBuffer());

    assert.equal(stored.width, image.IMAGE_DEFAULTS.MAX_EDGE);
    assert.equal(stored.height, image.IMAGE_DEFAULTS.MAX_EDGE / 2);
  });

  it('fits a tall image by its height', async () => {
    const stored = await image.toStoredImage(await canvas(1000, 4000).jpeg().toBuffer());

    assert.equal(stored.height, image.IMAGE_DEFAULTS.MAX_EDGE);
    assert.equal(stored.width, image.IMAGE_DEFAULTS.MAX_EDGE / 4);
  });

  it('never enlarges a small one', async () => {
    const stored = await image.toStoredImage(await canvas(300, 200).png().toBuffer());

    assert.equal(stored.width, 300);
    assert.equal(stored.height, 200);
  });

  it('turns a phone photo upright by its orientation before the orientation is dropped', async () => {
    const sideways = await canvas(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    const stored = await image.toStoredImage(sideways);

    assert.equal(stored.width, 100);
    assert.equal(stored.height, 200);
    assert.equal((await sharp(stored.data).metadata()).orientation, undefined);
  });

  it('refuses a GIF and a TIFF as formats not taken, naming the format', async () => {
    for (const [format, input] of [
      ['gif', await canvas(10, 10).gif().toBuffer()],
      ['tiff', await canvas(10, 10).tiff().toBuffer()],
    ] as const) {
      await assert.rejects(image.toStoredImage(input), (error) => {
        assert.ok(error instanceof image.UnsupportedImageError);
        assert.equal(error.code, image.IMAGE_ERROR.FORMAT_NOT_TAKEN);
        assert.equal(error.message, `Images of type ${format} are not taken`);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });

  it("refuses text as not an image, with sharp's own error as the cause", async () => {
    await assert.rejects(image.toStoredImage(Buffer.from('not an image at all')), (error) => {
      assert.ok(error instanceof image.UnsupportedImageError);
      assert.equal(error.code, image.IMAGE_ERROR.NOT_AN_IMAGE);
      assert.equal(error.message, 'Not an image');
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });

  it('refuses an empty file as not an image, rather than letting sharp throw its own error', async () => {
    await assert.rejects(image.toStoredImage(Buffer.alloc(0)), {
      ...refusedAs(image.IMAGE_ERROR.NOT_AN_IMAGE),
      message: 'Not an image',
    });
  });

  it("refuses an image cut off after its header as unreadable, with sharp's error as the cause", async () => {
    await assert.rejects(image.toStoredImage(await cutOffPhoto()), (error) => {
      assert.ok(error instanceof image.UnsupportedImageError);
      assert.equal(error.code, image.IMAGE_ERROR.UNREADABLE);
      assert.equal(error.message, 'The image could not be read');
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });

  it('refuses an image that would decode larger than the pixel limit', async () => {
    // Small as a file, huge once decoded: 8000 × 8000 is 64 megapixels.
    const bomb = await sharp({
      create: { width: 8000, height: 8000, channels: 3, background: '#000' },
    })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    assert.ok(8000 * 8000 > image.IMAGE_DEFAULTS.MAX_INPUT_PIXELS);

    await assert.rejects(image.toStoredImage(bomb), refusedAs(image.IMAGE_ERROR.NOT_AN_IMAGE));
    const unlimited = await image.toStoredImage(bomb, { maxInputPixels: false });
    assert.equal(unlimited.width, image.IMAGE_DEFAULTS.MAX_EDGE);
  });
});

describe('an uploaded image, stored another way', () => {
  it('is a JPEG of its own size and quality, from anything sharp reads', async () => {
    const gif = await canvas(1600, 800).gif().toBuffer();

    const stored = await image.toStoredImage(gif, {
      resize: { width: 1024, height: 1024, fit: sharp.fit.inside, withoutEnlargement: true },
      format: image.STORED_FORMAT.JPEG,
      quality: 80,
      inputFormats: null,
      failOn: image.FAIL_ON.WARNING,
    });

    assert.equal((await sharp(stored.data).metadata()).format, image.STORED_FORMAT.JPEG);
    assert.equal(stored.width, 1024);
    assert.equal(stored.height, 512);
  });

  it("is encoded at JPEG's default quality when no other is asked", async () => {
    const photo = await canvas(64, 48).png().toBuffer();
    const asJpeg = { format: image.STORED_FORMAT.JPEG };

    const stored = await image.toStoredImage(photo, asJpeg);
    const atDefault = await image.toStoredImage(photo, {
      ...asJpeg,
      quality: image.IMAGE_DEFAULTS.JPEG_QUALITY,
    });
    const atWebpDefault = await image.toStoredImage(photo, {
      ...asJpeg,
      quality: image.IMAGE_DEFAULTS.WEBP_QUALITY,
    });

    assert.ok(stored.data.equals(atDefault.data));
    assert.ok(!stored.data.equals(atWebpDefault.data));
  });

  it('is cropped to an exact size from the centre', async () => {
    const stored = await image.toStoredImage(await canvas(800, 600).png().toBuffer(), {
      resize: { width: 400, height: 400, fit: sharp.fit.cover },
    });

    assert.equal(stored.width, 400);
    assert.equal(stored.height, 400);
  });

  it('is enlarged to an exact size when its resize says so', async () => {
    const stored = await image.toStoredImage(await canvas(100, 100).png().toBuffer(), {
      resize: { width: 400, height: 400, fit: sharp.fit.cover },
    });

    assert.equal(stored.width, 400);
  });

  it('takes only the formats it is given', async () => {
    const onlyPng = { inputFormats: [image.IMAGE_FORMAT.PNG] };

    await image.toStoredImage(await canvas(10, 10).png().toBuffer(), onlyPng);
    await assert.rejects(
      image.toStoredImage(await canvas(10, 10).jpeg().toBuffer(), onlyPng),
      refusedAs(image.IMAGE_ERROR.FORMAT_NOT_TAKEN),
    );
    await assert.rejects(
      image.toStoredImage(await canvas(10, 10).png().toBuffer(), { inputFormats: [] }),
      refusedAs(image.IMAGE_ERROR.FORMAT_NOT_TAKEN),
    );
  });

  it('holds to a pixel limit of its own', async () => {
    const options = { maxInputPixels: 10_000 };

    await assert.rejects(
      image.toStoredImage(await canvas(200, 100).png().toBuffer(), options),
      refusedAs(image.IMAGE_ERROR.NOT_AN_IMAGE),
    );
    const small = await image.toStoredImage(await canvas(100, 100).png().toBuffer(), options);
    assert.equal(small.width, 100);
  });

  it('keeps what can be read of a cut-off file when told not to fail on it', async () => {
    const stored = await image.toStoredImage(await cutOffPhoto(), { failOn: image.FAIL_ON.NONE });

    assert.equal(stored.width, 300);
    assert.equal(stored.height, 300);
  });
});

describe('UnsupportedImageError', () => {
  it('can be made with no format and no cause', () => {
    const error = new image.UnsupportedImageError(image.IMAGE_ERROR.FORMAT_NOT_TAKEN);

    assert.ok(error instanceof Error);
    assert.equal(error.name, image.UnsupportedImageError.name);
    assert.equal(error.message, 'Images of type  are not taken');
    assert.equal(error.cause, undefined);
  });
});

describe('sharp, for the whole process', () => {
  it('is left as the app set it when the module is imported', () => {
    assert.equal(sharp.concurrency(), defaultThreads);
  });

  it('decodes on one thread without a cache once tuned for uploads', () => {
    image.tuneSharpForUploads();

    assert.equal(sharp.concurrency(), 1);
    assert.equal(sharp.cache().items.max, 0);
  });
});

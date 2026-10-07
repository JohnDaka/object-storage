# @dakaio/object-storage

Store what people upload in [Cloudflare R2](https://developers.cloudflare.com/r2/) or any other S3 API, or in a local folder while developing, behind one small interface. Requests are signed by [aws4fetch](https://github.com/mhart/aws4fetch) over the platform's own `fetch`, so there is no AWS SDK to carry. An optional [sharp](https://sharp.pixelplumbing.com) helper re-encodes each upload before it is stored, so no photo keeps its GPS position.

- **One interface, two stores.** `S3Storage` is a bucket on R2, MinIO or AWS; `LocalStorage` is a folder the app serves itself. The app picks one from its configuration, and the code that stores things never knows which.
- **No AWS SDK.** Path-style requests signed with SigV4 by aws4fetch, one file of about 11 KB with no dependencies of its own, over `fetch`.
- **Errors to act on.** Each of the package's failures has a `code`. A missing object is a `MediaObjectMissingError`, which a retry will not change. A refusal carries the store's HTTP status and its answer, and a retry may help.
- **Public and private buckets.** Long caching for objects that never change under their name; links that expire for objects nobody else may read.
- **A whole folder at once.** `deleteFolder()` lists the keys page by page and deletes a thousand at a time.
- **Images without their EXIF.** `@dakaio/object-storage/image` turns an upload upright, resizes it and re-encodes it, so no GPS position or camera serial is ever stored. sharp is an optional peer: the main entry never loads it.

## Why

An app that takes photos needs four things from its storage, and the usual answers bring more than that:

- **Put, read, delete, a public address.** The AWS SDK does it, at the cost of a large dependency tree. Here it is one tiny signing library and the platform's `fetch`.
- **A machine without the cloud.** A developer, or a test run, should not need an R2 bucket. `LocalStorage` keeps the same interface on a folder.
- **Private files shown to one person.** `signedUrlOf()` makes a link that works for as many seconds as asked, signed locally, with no request to the store.
- **No metadata nobody meant to publish.** A phone's photo carries where it was taken. `toStoredImage()` keeps the pixels and nothing else.

## Install

```sh
pnpm add @dakaio/object-storage
pnpm add sharp # only for @dakaio/object-storage/image
```

- Node 20 or later: the global `fetch` and Web Crypto are what the requests are signed and sent with.
- `aws4fetch` comes with the package. `sharp` (0.35 or later) is an optional peer, for the `./image` entry only.
- A CommonJS build with its TypeScript types, which ES modules import as well.

## The examples' own names

The examples take their settings from the app around them, and name every value they use. They share these names, as an app would keep them in its own constants:

```ts
// media.const.ts. The settings come from config.ts, read from the environment by whatever the
// app uses (envalid, dotenv, a NestJS ConfigService): `config.get(CONFIG.R2_BUCKET)` and the like.

/** The folders objects are kept in, one per kind. */
export const MEDIA_FOLDER = {
  /** Photos people upload, for everyone to see. */
  PHOTOS: 'photos',
  /** One avatar per person. */
  AVATARS: 'avatars',
  /** Uploads nobody else may see yet. */
  UPLOADS: 'uploads',
  /** Everything one person keeps, deleted along with their account. */
  USERS: 'users',
} as const;

/** How long a link to a private upload works: ten minutes, in seconds. */
export const UPLOAD_LINK_SECONDS = 600;

/** An avatar's side, in pixels. */
export const AVATAR_SIDE = 400;

/** A notification picture's longer side at most, in pixels: phones scale it down further. */
export const NOTIFICATION_EDGE = 1024;

/** A notification picture's JPEG quality, in percent. */
export const NOTIFICATION_QUALITY = 80;

/** Where the API serves the local folder in development, under its own prefix. */
export const LOCAL_MEDIA_ROUTE = '/api/v1/media';
```

## Quick start

A photo uploaded, re-encoded, stored in R2 and shown from the bucket's own domain:

```ts
import { randomUUID } from 'node:crypto';
import { IMMUTABLE_CACHE_CONTROL, r2EndpointOf, S3Storage } from '@dakaio/object-storage';
import { IMAGE_CONTENT_TYPE, STORED_FORMAT, toStoredImage } from '@dakaio/object-storage/image';

import { config, CONFIG } from './config';
import { MEDIA_FOLDER } from './media.const';

const media = new S3Storage({
  endpoint: r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID)),
  accessKeyId: config.get(CONFIG.R2_ACCESS_KEY_ID),
  secretAccessKey: config.get(CONFIG.R2_SECRET_ACCESS_KEY),
  bucket: config.get(CONFIG.R2_BUCKET),
  publicUrl: config.get(CONFIG.MEDIA_PUBLIC_URL),
  cacheControl: IMMUTABLE_CACHE_CONTROL,
});

/** Stores an uploaded photo, and gives the address it is shown at. */
export const storePhoto = async (upload: Buffer): Promise<string> => {
  const photo = await toStoredImage(upload);
  const key = `${MEDIA_FOLDER.PHOTOS}/${randomUUID()}`;

  await media.put(key, photo.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);

  return media.urlOf(key); // https://cdn.example.com/photos/<uuid>
};
```

## A public bucket on R2

```ts
const media = new S3Storage({
  endpoint: r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID)),
  accessKeyId: config.get(CONFIG.R2_ACCESS_KEY_ID),
  secretAccessKey: config.get(CONFIG.R2_SECRET_ACCESS_KEY),
  bucket: config.get(CONFIG.R2_BUCKET),
  // The bucket's custom domain, which urlOf() builds addresses on.
  publicUrl: config.get(CONFIG.MEDIA_PUBLIC_URL),
  // A changed photo gets a new key, so each object may be cached for good.
  cacheControl: IMMUTABLE_CACHE_CONTROL,
});

await media.put(photo.key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
media.urlOf(photo.key); // https://cdn.example.com/photos/<id>
const bytes = await media.get(photo.key);
await media.delete(photo.key); // one already gone is no failure
```

The same class works for MinIO or AWS: give it their `endpoint` and `region`. A request is path-style, `<endpoint>/<bucket>/<key>`.

### A bucket made with a jurisdiction

A bucket made in the EU is reached only at its own address; the ordinary one answers it 403 AccessDenied, however right the token is. `r2EndpointOf()` takes the jurisdiction as the bucket was made:

```ts
const media = new S3Storage({
  endpoint: r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID), config.get(CONFIG.R2_JURISDICTION)),
  // ...
});
// https://<account id>.eu.r2.cloudflarestorage.com with `eu`, the ordinary address with none
```

## A private bucket and links that expire

A private bucket has no public address. An object in it is shown to the one person it is for through a link that works for as many seconds as asked, then never again. The file does not pass through the app, and making the link asks nothing of the store.

```ts
import { PRIVATE_CACHE_CONTROL, S3Storage } from '@dakaio/object-storage';

const uploads = new S3Storage({
  endpoint: r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID)),
  accessKeyId: config.get(CONFIG.R2_ACCESS_KEY_ID),
  secretAccessKey: config.get(CONFIG.R2_SECRET_ACCESS_KEY),
  bucket: config.get(CONFIG.R2_PRIVATE_BUCKET),
  cacheControl: PRIVATE_CACHE_CONTROL,
});

await uploads.put(upload.key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
const previewUrl = await uploads.signedUrlOf(upload.key, UPLOAD_LINK_SECONDS);
```

`uploads.urlOf()` throws `NO_PUBLIC_URL`: there is nothing public to point at. `uploads.configured` is false while either key is empty, for a server that turns a feature off when no storage is set up.

## Deleting a whole folder

```ts
// Everything a closed account kept:
await media.deleteFolder(`${MEDIA_FOLDER.USERS}/${user.id}`);
```

Everything under `<folder>/` goes, at any depth. A folder whose name merely starts the same (`users/12` next to `users/1`) is not touched. An empty or missing folder is no failure.

## Any other request

`send()` is the signed request the other methods are made of, for what they do not cover. Its failures are theirs: a 404 is `OBJECT_MISSING`, anything else but a success is `STORE_REFUSED`.

```ts
import { HTTP_METHOD, MediaObjectMissingError } from '@dakaio/object-storage';

/** Whether the photo is there, without downloading it. */
const isStored = (key: string): Promise<boolean> =>
  media
    .send(HTTP_METHOD.HEAD, key)
    .then(() => true)
    .catch((error: unknown) => {
      const missing = error instanceof MediaObjectMissingError;
      if (missing) {
        return false;
      }
      throw error;
    });
```

`apiUrlOf(key)` is the object's address on the S3 API: what a request is signed for, and what a private object answers 403 at without a signature.

## A local folder in development

`LocalStorage` keeps the same interface on a folder of this machine's, which the app serves itself. Nothing else changes, so a developer or a test run needs no bucket at all.

```ts
import { resolve } from 'node:path';
import { LocalStorage } from '@dakaio/object-storage';

const media = new LocalStorage({ dir: config.get(CONFIG.MEDIA_DIR), publicUrl: LOCAL_MEDIA_ROUTE });

// main.ts, NestJS on Express: the folder at the address urlOf() gives.
app.useStaticAssets(resolve(config.get(CONFIG.MEDIA_DIR)), { prefix: LOCAL_MEDIA_ROUTE });

await media.put(photo.key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
media.urlOf(photo.key); // /api/v1/media/photos/<id>
```

A key that would land outside the folder, such as `../x`, or on the folder itself, is refused with `KEY_OUTSIDE_FOLDER` before any path is touched. The content type is not kept: the static route tells it by the file's name.

## One store or the other, by configuration

With NestJS, the choice is a provider, and the rest of the app asks for the interface:

```ts
import { Inject, Injectable, Module } from '@nestjs/common';
import {
  IMMUTABLE_CACHE_CONTROL,
  LocalStorage,
  r2EndpointOf,
  S3Storage,
} from '@dakaio/object-storage';
import type { MediaStorage } from '@dakaio/object-storage';

/** The token the store is injected by. */
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

/** R2 when its account is set, the local folder otherwise. */
const mediaStorageOf = (): MediaStorage =>
  config.get(CONFIG.R2_ACCOUNT_ID)
    ? new S3Storage({
        endpoint: r2EndpointOf(config.get(CONFIG.R2_ACCOUNT_ID)),
        accessKeyId: config.get(CONFIG.R2_ACCESS_KEY_ID),
        secretAccessKey: config.get(CONFIG.R2_SECRET_ACCESS_KEY),
        bucket: config.get(CONFIG.R2_BUCKET),
        publicUrl: config.get(CONFIG.MEDIA_PUBLIC_URL),
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      })
    : new LocalStorage({ dir: config.get(CONFIG.MEDIA_DIR), publicUrl: LOCAL_MEDIA_ROUTE });

@Module({
  providers: [{ provide: MEDIA_STORAGE, useFactory: mediaStorageOf }],
  exports: [MEDIA_STORAGE],
})
export class MediaModule {}

@Injectable()
export class PhotosService {
  constructor(@Inject(MEDIA_STORAGE) private readonly storage: MediaStorage) {}
}
```

## The key behind a public address

A profile's picture may be one the app stored, or one a sign-in provider gave. `publicKeyIn()` reads the key back out of an address only when it is one of the store's own in the folder, so only the app's own file is ever deleted:

```ts
import { publicKeyIn } from '@dakaio/object-storage';

const oldKey = publicKeyIn(media, MEDIA_FOLDER.AVATARS, user.avatarUrl);
if (oldKey) {
  await media.delete(oldKey);
}
```

## Buckets on a local S3 store

For development and the tests against MinIO, or a store like it, `ensureBuckets()` makes the buckets. The public one gets a policy that lets anyone read its objects, which is what R2 does for a bucket served on a custom domain; the private one gets none. A bucket that is there already is no failure, so it is safe to run again.

```ts
import { ensureBuckets } from '@dakaio/object-storage';

// The tests' global setup: buckets of their own, so a test run never touches the dev data.
await ensureBuckets({
  endpoint: config.get(CONFIG.S3_ENDPOINT),
  region: config.get(CONFIG.S3_REGION),
  accessKeyId: config.get(CONFIG.S3_ACCESS_KEY_ID),
  secretAccessKey: config.get(CONFIG.S3_SECRET_ACCESS_KEY),
  publicBucket: config.get(CONFIG.TEST_PUBLIC_BUCKET),
  privateBucket: config.get(CONFIG.TEST_PRIVATE_BUCKET),
});
```

Not for R2 itself: there the buckets and the public one's domain are made in the Cloudflare dashboard.

## Images

### Re-encoding an upload

```ts
import { IMAGE_CONTENT_TYPE, STORED_FORMAT, toStoredImage } from '@dakaio/object-storage/image';

const image = await toStoredImage(upload.buffer); // { data, width, height }
await media.put(photo.key, image.data, IMAGE_CONTENT_TYPE[STORED_FORMAT.WEBP]);
```

The image is decoded, turned upright by its EXIF orientation, resized and re-encoded, so what is stored is only pixels: no EXIF, no GPS position from a phone camera, no camera serial, no embedded thumbnail that might show something the crop does not. Its format is read from the bytes, never from the file name or the type the client claimed. By default it is a WebP no larger than 2048 px on its longer side; a smaller image keeps its size.

### Another size, another format

```ts
import { fit } from 'sharp';
import { FAIL_ON, STORED_FORMAT, toStoredImage } from '@dakaio/object-storage/image';

// Exactly a square, cropped from the centre:
const avatar = await toStoredImage(upload.buffer, {
  resize: { width: AVATAR_SIDE, height: AVATAR_SIDE, fit: fit.cover },
});

// A JPEG for a push notification, from anything sharp can read, and strict about damage:
const picture = await toStoredImage(upload.buffer, {
  resize: { width: NOTIFICATION_EDGE, height: NOTIFICATION_EDGE, fit: fit.inside, withoutEnlargement: true },
  format: STORED_FORMAT.JPEG,
  quality: NOTIFICATION_QUALITY,
  inputFormats: null,
  failOn: FAIL_ON.WARNING,
});
```

For a photo and its preview, call it twice with two sizes: each call decodes the upload once, as sharp would for two outputs anyway.

### Tuning sharp for uploads

Importing the entry changes nothing in sharp. A server that decodes one stranger's upload after another calls `tuneSharpForUploads()` once at boot:

```ts
import { tuneSharpForUploads } from '@dakaio/object-storage/image';

tuneSharpForUploads(); // main.ts, before the first upload
```

It sets, for the whole process, one libvips thread per image (`sharp.concurrency(1)`), so a large upload takes one core rather than all of them, and no operation cache (`sharp.cache(false)`), since no upload is decoded twice.

## Options

### `S3StorageOptions`

| Option | Type | Default | Unit | Meaning |
|---|---|---|---|---|
| `endpoint` | `string` | required | URL | The S3 API's address, with no bucket in it: `r2EndpointOf(accountId)`, or a local store's |
| `region` | `string` | `'auto'` | | The region requests are signed for. An empty one counts as none: R2's `auto` |
| `accessKeyId` | `string` | required | | The access key's ID: an R2 API token's, or a local store's user |
| `secretAccessKey` | `string` | required | | The access key's secret |
| `bucket` | `string` | required | | The bucket's name |
| `publicUrl` | `string` | none | URL | Where everyone reads the objects, such as the bucket's custom domain. A slash at the end is dropped. None for a private bucket |
| `cacheControl` | `string` | none | | The Cache-Control every object is put with: `IMMUTABLE_CACHE_CONTROL`, `PRIVATE_CACHE_CONTROL`, or any other |

### `LocalStorageOptions`

| Option | Type | Default | Unit | Meaning |
|---|---|---|---|---|
| `dir` | `string` | required | path | The folder, absolute or from the working directory. Subfolders are made as they are needed |
| `publicUrl` | `string` | required | URL or path | Where the app serves the folder: a path on its own origin, or a whole address. A slash at the end is dropped |

### `StorageSettings` (`ensureBuckets`)

| Option | Type | Default | Unit | Meaning |
|---|---|---|---|---|
| `endpoint`, `region`, `accessKeyId`, `secretAccessKey` | | | | As in `S3StorageOptions` |
| `publicBucket` | `string` | none | | Made, and given a policy that lets anyone read its objects |
| `privateBucket` | `string` | none | | Made, with no policy |

### `ImageOptions` (`toStoredImage`)

| Option | Type | Default | Unit | Meaning |
|---|---|---|---|---|
| `resize` | sharp's `ResizeOptions` | `IMAGE_DEFAULTS.MAX_EDGE` (2048) on each side, `fit: inside`, `withoutEnlargement: true` | pixels | How the image is fitted. Replaces the default as a whole |
| `format` | `STORED_FORMAT` | `IMAGE_DEFAULTS.FORMAT` (`webp`) | | What the image is stored as |
| `quality` | `number` | `IMAGE_DEFAULTS.WEBP_QUALITY` (82) for WebP, `IMAGE_DEFAULTS.JPEG_QUALITY` (85) for JPEG | percent | The encoder's quality |
| `inputFormats` | `string[]` or `null` | `IMAGE_DEFAULTS.INPUT_FORMATS` (`jpeg`, `png`, `webp`) | | The formats taken, as `IMAGE_FORMAT` names them, read from the bytes. `null` takes whatever sharp can read |
| `maxInputPixels` | `number` or `boolean` | `IMAGE_DEFAULTS.MAX_INPUT_PIXELS` (40 000 000) | pixels (width × height) | A larger image is refused before it is decoded, since a small file can unpack huge. `true` is sharp's own limit, `false` none |
| `failOn` | `FAIL_ON` | `IMAGE_DEFAULTS.FAIL_ON` (`error`) | | How damaged the pixel data may be before the image is refused |

## Errors

Every failure of a store is a `MediaStorageError`, its `code` one of `MEDIA_STORAGE_ERROR`:

| Code | When | A retry |
|---|---|---|
| `OBJECT_MISSING` | No such object; for an S3 store, no such bucket either. Thrown as a `MediaObjectMissingError` | Will not help |
| `STORE_REFUSED` | The S3 store answered anything but a success. `status` is its HTTP status, and its XML answer is in the message | May help |
| `KEY_OUTSIDE_FOLDER` | `LocalStorage` was given a key outside its folder, or the folder itself | Will not help |
| `NO_PUBLIC_URL` | `urlOf()` of a bucket with no `publicUrl` | Will not help |

`delete()` never throws `OBJECT_MISSING`: deleting what is not there is no failure. A local folder's other failures, such as a key that names a folder, are the file system's own errors.

Every refused image is an `UnsupportedImageError`, its `code` one of `IMAGE_ERROR`, and sharp's own error, if any, its `cause`. It is always the uploader's mistake, never the server's:

| Code | When |
|---|---|
| `NOT_AN_IMAGE` | Not an image sharp will open: not an image at all, an empty file, or one over the pixel limit |
| `FORMAT_NOT_TAKEN` | An image of a format not in `inputFormats` |
| `UNREADABLE` | The header was read but not the pixels: a damaged or cut-off file |

Caught by their classes and codes, never by their messages:

```ts
import { ServiceUnavailableException, UnsupportedMediaTypeException } from '@nestjs/common';
import { MEDIA_STORAGE_ERROR, MediaStorageError } from '@dakaio/object-storage';
import { UnsupportedImageError } from '@dakaio/object-storage/image';

/** Whether the store refused: its token, its rights, its network. */
const isRefusal = (error: unknown): error is MediaStorageError =>
  error instanceof MediaStorageError && error.code === MEDIA_STORAGE_ERROR.STORE_REFUSED;

export const uploadPhoto = async (upload: Buffer): Promise<string> => {
  try {
    return await storePhoto(upload);
  } catch (error) {
    const notAnImage = error instanceof UnsupportedImageError;
    if (notAnImage) {
      throw new UnsupportedMediaTypeException(); // 415: the uploader's to fix
    }
    const refused = isRefusal(error);
    if (refused) {
      throw new ServiceUnavailableException(); // 503: error.status tells the owner why
    }
    throw error;
  }
};
```

## How it works, and caveats

- **Signing.** Every request is signed with SigV4 by aws4fetch, for the region given (R2's `auto` by default) and the `s3` service. A link from `signedUrlOf()` carries its signature and its expiry in its query, and is made without asking the store anything. S3 and R2 take a week at most.
- **Retries.** aws4fetch tries a request that fails with a 5xx or a 429 again, with backoff, up to 10 times. Any other 4xx is answered at once.
- **Keys.** A key goes into the request's path as it is. Keep keys to URL-safe characters, such as random names, ids and `/`: a `?` or `#` would end the path, and a `+` is signed as a space.
- **Missing objects.** S3 answers a missing bucket with the same 404 as a missing object, so both are `OBJECT_MISSING`.
- **Deleting a folder.** The folder is listed a thousand keys at a time, and each page is deleted in one DeleteObjects request, in quiet mode: the answer names only the keys it could not delete, and it is not read. It is not atomic either: an object put while the folder is being deleted may stay.
- **Public addresses.** `urlOf()` builds the address from `publicUrl`; it asks the store nothing, so it holds only as long as the bucket really is served there.
- **A local folder.** `LocalStorage` refuses any key that would resolve outside its folder, the folder itself included, before it touches the disk. It does not keep content types.
- **Images.** sharp reads an image's first frame: an animated GIF or WebP is stored still. An image with a colour profile is converted to sRGB, and the profile dropped with the rest of the metadata.
- **Errors in messages.** A refusal's message carries the request's method and path, the key included, and the store's XML answer: mind them in logs others read.

## API reference

### `@dakaio/object-storage`

| Export | Kind | What it is |
|---|---|---|
| `S3Storage` | class | A bucket on R2 or any S3 API |
| `LocalStorage` | class | A folder of this machine's, for development and the tests |
| `MediaStorage` | interface | What both stores keep to: `put`, `get`, `delete`, `deleteFolder`, `urlOf` |
| `MediaStorageError` | class | A store's failure: `code`, and `status` for a refusal |
| `MediaObjectMissingError` | class | The object is not there; a `MediaStorageError` with the code `OBJECT_MISSING` |
| `MEDIA_STORAGE_ERROR` | constant and type | The codes of a store's failures |
| `StoreAnswer` | interface | What a store answered a refused request: `status`, `text` |
| `r2EndpointOf(accountId, jurisdiction?)` | function | R2's S3 address for an account, in a jurisdiction or not |
| `IMMUTABLE_CACHE_CONTROL` | constant | `public, max-age=31536000, immutable`: for objects that never change under their name |
| `PRIVATE_CACHE_CONTROL` | constant | `private`: no shared cache keeps the object |
| `publicKeyIn(storage, folder, url)` | function | The key behind one of the store's public addresses in a folder, or `null` |
| `ensureBuckets(settings)` | function | Makes a public and a private bucket on a local S3 store |
| `HTTP_METHOD` | constant and type | The HTTP methods, for `send()` |
| `S3Connection` | interface | An S3 API and its keys: `endpoint`, `region`, `accessKeyId`, `secretAccessKey` |
| `S3StorageOptions` | interface | `S3Connection` and the bucket: `bucket`, `publicUrl`, `cacheControl` |
| `S3RequestInit` | interface | A request's `headers`, `body` and `query`, for `send()` |
| `LocalStorageOptions` | interface | `dir`, `publicUrl` |
| `StorageSettings` | interface | `S3Connection` and the buckets to make: `publicBucket`, `privateBucket` |

`S3Storage` and `LocalStorage`, method by method:

| Method | `S3Storage` | `LocalStorage` |
|---|---|---|
| `put(key, body, contentType)` | PUT, with the content type and the store's Cache-Control | Writes the file, making its folders |
| `get(key)` | The bytes; `OBJECT_MISSING` for none | The file's bytes; `OBJECT_MISSING` for none |
| `delete(key)` | DELETE; already gone is no failure | Removes the file; already gone is no failure |
| `deleteFolder(folder)` | ListObjectsV2 and DeleteObjects, a thousand keys at a time | Removes the folder and everything in it |
| `urlOf(key)` | `publicUrl` and the key; `NO_PUBLIC_URL` without one | `publicUrl` and the key |
| `signedUrlOf(key, seconds)` | A GET link that works for that many seconds | |
| `apiUrlOf(key?)` | The object's or the bucket's address on the S3 API | |
| `send(method, key?, init?)` | Any other signed request | |
| `configured` | Whether both keys are set | |

### `@dakaio/object-storage/image`

| Export | Kind | What it is |
|---|---|---|
| `toStoredImage(input, options?)` | function | An upload re-encoded as it is to be stored: `{ data, width, height }` |
| `tuneSharpForUploads()` | function | One libvips thread per image and no operation cache, for the whole process; once at boot |
| `UnsupportedImageError` | class | A refused image: `code`, and sharp's error as its `cause` |
| `IMAGE_ERROR` | constant and type | The codes of a refused image |
| `IMAGE_DEFAULTS` | constant | What `toStoredImage()` does unless told otherwise |
| `IMAGE_FORMAT` | constant and type | Image formats as sharp names them: `jpeg`, `png`, `webp` |
| `STORED_FORMAT` | constant and type | What an image is stored as: `webp` or `jpeg` |
| `IMAGE_CONTENT_TYPE` | constant | The content type of each stored format |
| `FAIL_ON` | constant and type | How damaged pixel data may be before sharp gives up |
| `StoredImage` | interface | `data`, `width`, `height` |
| `ImageOptions` | interface | `resize`, `format`, `quality`, `inputFormats`, `maxInputPixels`, `failOn` |

## License

MIT

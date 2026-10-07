/**
 * The S3 API as the stores speak it: methods, statuses, headers, query parameters, the XML of a
 * listing and of a batch delete, a public bucket's policy. For the package's own use, `HTTP_METHOD`
 * aside, which the main entry exports for `S3Storage.send()`.
 */

/** The HTTP methods: the ones the stores send, and `HEAD` for an app's own `send()`. */
export const HTTP_METHOD = {
  /** Reads an object, or a bucket's listing. */
  GET: 'GET',
  /** Stores an object; makes a bucket, or sets its policy. */
  PUT: 'PUT',
  /** A batch delete, DeleteObjects: up to a thousand keys in one request. */
  POST: 'POST',
  /** Deletes an object. */
  DELETE: 'DELETE',
  /**
   * Asks after an object without its body: whether it is there, its size, its type. The stores
   * never send it themselves; it is here for `send()`.
   */
  HEAD: 'HEAD',
} as const;
/** One of `HTTP_METHOD`'s methods. */
export type HTTP_METHOD = (typeof HTTP_METHOD)[keyof typeof HTTP_METHOD];

/** The HTTP statuses told apart from any other failure. */
export const HTTP_STATUS = {
  /** No such object, or no such bucket. */
  NOT_FOUND: 404,
  /** A bucket asked to be made that is there already, and ours. */
  CONFLICT: 409,
} as const;

/** The request headers the stores set, as fetch sends them: in lower case. */
export const HEADER = {
  /** What the object is, as it is served: `image/webp`. */
  CONTENT_TYPE: 'content-type',
  /** How long browsers and CDNs may keep the object. */
  CACHE_CONTROL: 'cache-control',
  /** The body's checksum, which S3 asks of a batch delete. */
  CONTENT_MD5: 'content-md5',
} as const;

/** The content type of a batch delete's body. */
export const XML_CONTENT_TYPE = 'application/xml';

/** How a batch delete's checksum is made and written. */
export const CHECKSUM = {
  /** MD5, the checksum Content-MD5 carries. */
  ALGORITHM: 'md5',
  /** In base64, as Content-MD5 has it. */
  ENCODING: 'base64',
} as const;

/** The service aws4fetch signs for: S3, which R2 and MinIO speak too. */
export const S3_SERVICE = 's3';

/** R2's one region, which a store given none is signed for. */
export const R2_REGION = 'auto';

/** The S3 API's query parameters. */
export const S3_QUERY = {
  /** Which listing: `LIST_OBJECTS_V2`, the one with continuation tokens. */
  LIST_TYPE: 'list-type',
  /** The keys a listing is narrowed to: those that start with it. */
  PREFIX: 'prefix',
  /** The most keys in a listing's page. */
  MAX_KEYS: 'max-keys',
  /** Where a listing goes on from: the token the page before gave. */
  CONTINUATION_TOKEN: 'continuation-token',
  /** A POST to a bucket with it is a batch delete, DeleteObjects. */
  DELETE: 'delete',
  /** A PUT to a bucket with it sets the bucket's policy. */
  POLICY: 'policy',
  /** How long a link signed in advance works, in seconds. */
  EXPIRES: 'X-Amz-Expires',
} as const;

/** `list-type` for ListObjectsV2. */
export const LIST_OBJECTS_V2 = '2';

/** S3's most keys in one listing page, and in one batch delete. */
export const S3_MAX_KEYS = 1000;

/** The XML the S3 API reads and writes. */
export const S3_XML = {
  /** What an XML document starts with, as S3 writes its own. */
  DECLARATION: '<?xml version="1.0" encoding="UTF-8"?>',
  /** The S3 namespace, as an attribute of a request's root element. */
  NAMESPACE_ATTRIBUTE: ' xmlns="http://s3.amazonaws.com/doc/2006-03-01/"',
  /** A boolean that is set, as S3 writes it. */
  TRUE: 'true',
} as const;

/** The XML elements read and written. */
export const S3_XML_TAG = {
  /** An object's key: in each of a listing's entries, and in each of a batch delete's objects. */
  KEY: 'Key',
  /** Whether a listing has more pages after this one. */
  IS_TRUNCATED: 'IsTruncated',
  /** The token a listing's next page is asked for with. */
  NEXT_CONTINUATION_TOKEN: 'NextContinuationToken',
  /** A batch delete's root element. */
  DELETE: 'Delete',
  /** Asks a batch delete to answer with the keys it could not delete, and nothing else. */
  QUIET: 'Quiet',
  /** One object in a batch delete. */
  OBJECT: 'Object',
} as const;

/** A bucket policy that lets anyone read the bucket's objects, in its parts. */
export const PUBLIC_READ_POLICY = {
  /** The policy language's version: the current one, of 2012. */
  VERSION: '2012-10-17',
  /** What the statement does: allows. */
  EFFECT: 'Allow',
  /** Anyone at all, signed in or not. */
  PRINCIPAL: '*',
  /** Reading an object, and nothing else: no listing, no writing. */
  ACTION: 's3:GetObject',
  /** How a policy names a bucket: this, then the bucket's name. */
  BUCKET_ARN_PREFIX: 'arn:aws:s3:::',
  /** After a bucket's name: every object in it. */
  EVERY_OBJECT: '/*',
} as const;

/** A request as an error names it: `PUT /bucket/key`. */
export const requestOf = (method: string, path: string): string => `${method} /${path}`;

/** The characters XML text has to escape, and how it writes each. */
const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** The named entities XML has, and the character each stands for. */
const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Any character `XML_ESCAPES` has. */
const XML_SPECIAL_CHARACTERS = /[&<>"']/g;
/** An entity, by its name or by its number: `&amp;`, `&#39;`, `&#x27;`. */
const XML_ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g;
/** What starts a character's number written in hexadecimal: `&#x27;`. */
const HEX_REFERENCE = '#x';
/** What starts a character's number: `&#39;`. */
const DECIMAL_REFERENCE = '#';
/** The base of a hexadecimal number. */
const HEX_RADIX = 16;
/** The base of a decimal number. */
const DECIMAL_RADIX = 10;
/** The text inside an element: everything up to the next tag, as the pattern's first group. */
const ELEMENT_TEXT = '([^<]*)';
/** Every match in a text, not the first only. */
const EVERY_MATCH = 'g';

/** Text as XML writes it: `&`, `<`, `>` and both quotes as entities, so a key cannot break out. */
export const escapeXml = (text: string): string =>
  text.replace(XML_SPECIAL_CHARACTERS, (char) => XML_ESCAPES[char]);

/**
 * XML's text as it was meant: the named entities and the numbered ones, decimal or hexadecimal,
 * turned back into their characters. An entity XML does not name is left as it is.
 */
export const unescapeXml = (text: string): string =>
  text.replace(XML_ENTITY, (entity: string, name: string) => {
    const hex = name.startsWith(HEX_REFERENCE);
    if (hex) {
      return String.fromCodePoint(parseInt(name.slice(HEX_REFERENCE.length), HEX_RADIX));
    }
    const decimal = name.startsWith(DECIMAL_REFERENCE);
    if (decimal) {
      return String.fromCodePoint(parseInt(name.slice(DECIMAL_REFERENCE.length), DECIMAL_RADIX));
    }
    return XML_ENTITIES[name] ?? entity;
  });

/** `<tag>content</tag>`, the content escaped already, and the attributes, if any, after the tag's name. */
export const xmlElementOf = (tag: string, content: string, attributes = ''): string =>
  `<${tag}${attributes}>${content}</${tag}>`;

/**
 * The text of every `<tag>` in an S3 answer, unescaped. A listing's tags hold text and nothing
 * else, so a pattern reads them as well as a parser would, and there is no parser to depend on.
 */
export const xmlValuesOf = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(xmlElementOf(tag, ELEMENT_TEXT), EVERY_MATCH))].map(([, value]) =>
    unescapeXml(value),
  );

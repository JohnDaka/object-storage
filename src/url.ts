/**
 * Addresses as the stores build them: an object's from its base and its key, a folder's prefix, a
 * query. For the package's own use.
 */

/** Between an address's parts: the endpoint and the bucket, the bucket and the key, a folder and what is in it. */
const PATH_SEPARATOR = '/';
/** What a query starts with, after the path. */
const QUERY_START = '?';
/** Between a query's parameters. */
const QUERY_SEPARATOR = '&';
/** Between a parameter's name and its value. */
const QUERY_ASSIGN = '=';
/** One slash or more at the end of an address. */
const TRAILING_SLASHES = /\/+$/;

/**
 * An address to put `/<key>` after: without a slash of its own at the end, so that a base written
 * `https://cdn.example.com/` does not give `https://cdn.example.com//key`.
 */
export const withoutTrailingSlashes = (url: string): string => url.replace(TRAILING_SLASHES, '');

/** The parts joined into one address, a slash between each two: `endpoint/bucket/key`. */
export const joinedPath = (...parts: string[]): string => parts.join(PATH_SEPARATOR);

/** What every key in a folder starts with: the folder's name and a slash. */
export const folderPrefixOf = (folder: string): string => `${folder}${PATH_SEPARATOR}`;

/**
 * The address with its query. Each name and value is URI-encoded, a space as `%20` and a plus as
 * `%2B`, so the store reads them as they were meant and its signature check agrees. With nothing
 * to ask, the address is left as it is, without a `?`.
 */
export const withQuery = (url: string, query: Record<string, string>): string => {
  const search = Object.entries(query)
    .map(
      ([name, value]) => `${encodeURIComponent(name)}${QUERY_ASSIGN}${encodeURIComponent(value)}`,
    )
    .join(QUERY_SEPARATOR);

  return search ? `${url}${QUERY_START}${search}` : url;
};

# Contributing

## Development

```sh
pnpm typecheck       # the sources and the specs
pnpm lint            # ESLint and Prettier; `pnpm format` fixes what it can
pnpm test            # node:test, straight from TypeScript
pnpm test:coverage   # the same, held to full coverage of lines, branches and functions
pnpm build
```

No magic values: a text is compared through a named constant (an `as const` object and its type), and every number is a named, documented constant. `pnpm lint` enforces both. The S3 specs run against a small S3 server of their own, which checks every request's signature as S3 does; nothing in them needs the network.

## Releasing

Raise `version` in `package.json` in a pull request. After it is merged, run `pnpm release` on a clean checkout: it tags `main` with `v<version>` and pushes the tag, and the `publish` workflow tests, builds and publishes to npm.

Publishing uses npm trusted publishing: no token is stored anywhere. The first version is published by hand from a clean checkout (`pnpm install`, `npm login`, then `npm publish --provenance=false`: provenance can only be made inside GitHub Actions); after that the package's npm settings name this repository's `publish.yml` as its Trusted Publisher.

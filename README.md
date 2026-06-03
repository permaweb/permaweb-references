# @permaweb/references

TypeScript SDK for Permaweb Names references.

The SDK reads `reference@1.0` records from Arweave GraphQL, joins them with the
current phase-2 namespace root reference, and can post reference updates through an
Arweave bundler.

## Install

```bash
npm install @permaweb/references
```

Read-only usage does not need wallet dependencies. Writing with the built-in
signers needs the optional peer packages used by that signer:

```bash
npm install arweave arbundles
```

## Quick Start

```ts
import { ReferenceClient } from '@permaweb/references';

const names = new ReferenceClient();

const refs = await names.findReferences(
  '8s8ABYc_1oDZ553UKXLIzsUie48xc6V88Q1hPtky4C8',
);

console.log(refs);
// [
//   {
//     referenceId: '_aY3NpheRlJ4y_MInEZpzCSBHXl1hL3osyfkOSQY6Ek',
//     name: '1984',
//     value: 'n2ITIV8xMI2JeeABVsyUyYK0jaOSSJwu9ekxioXGbeA'
//   }
// ]
```

## Read References

Resolve the current value of a reference:

```ts
const value = await names.resolveReference(referenceId);
```

Fetch full reference state:

```ts
const ref = await names.getReference(referenceId);

// {
//   id: string,
//   authority?: string,
//   value: unknown,
//   timestamp: number,
//   source: 'init' | 'set'
// }
```

List references controlled by a wallet:

```ts
const refs = await names.findReferences(authorityAddress);

// [
//   {
//     referenceId: string,
//     name: string | null,
//     value: unknown,
//     nameSource?: string,
//     dateRegistered?: string
//   }
// ]
```

`findReferences` returns references controlled by an authority. It is not an
"all names" or "all subdomains" listing API. All-name discovery should read the
namespace manifest/state directly.

## Update References

### Browser Wallet

```ts
import { ReferenceClient, fromWallet } from '@permaweb/references';

const names = new ReferenceClient({
  signer: fromWallet(window.arweaveWallet),
});

await names.updateReference(referenceId, {
  value: 'NEW_TARGET_TX_ID',
});
```

### JWK

```ts
import { ReferenceClient, fromJwk } from '@permaweb/references';

const names = new ReferenceClient({
  signer: fromJwk(jwk),
  bundler: 'https://up.arweave.net',
});

await names.updateReference(referenceId, {
  value: 'NEW_TARGET_TX_ID',
});
```

The signer must be the reference authority. The SDK checks the current reference
authority before posting and throws without sending if the signer does not match.

When `timestamp` is not supplied, `updateReference` reads the current reference
state and uses:

```ts
Math.max(Date.now(), latestTimestamp + 1)
```

This keeps updates strictly newer even if the latest reference timestamp is ahead
of the local clock or multiple updates happen close together. Pass `timestamp`
explicitly only when you need to control the nonce yourself.

## Create References

```ts
const { referenceId } = await names.createReference({
  value: targetTxId,
});
```

For user-created references, `authority` defaults to the signer address. Pass an
explicit `authority` when a bootstrap publisher is creating the reference on
behalf of another wallet. The resulting data item ID is the reference ID.

## Configuration

```ts
const names = new ReferenceClient({
  gateway: 'https://arweave.net',
  graphql: 'https://arweave.net/graphql',
  bundler: 'https://up.arweave.net',
  namespace: 'w0eqd43OMzzXr-5yhFC-LkgifQqih8YEPb4mLt6VSZo',
  trustedPublishers: [
    'uAaRGha_a1ni_VjLf9Be2SFB7NJw1PWnjevdfeuJ_7c',
  ],
  fetch,
});
```

| Option | Default | Description |
| --- | --- | --- |
| `gateway` | `https://arweave.net` | Gateway used for tx reads and raw namespace fetches. |
| `graphql` | `${gateway}/graphql` | GraphQL endpoint used for reference discovery. |
| `bundler` | `https://up.arweave.net` | Bundler endpoint used by the JWK signer. |
| `namespace` | phase-2 namespace root | Namespace root reference or manifest ID used to attach names to references. Set `null` to skip name lookup. |
| `trustedPublishers` | phase-2 bootstrap publisher | Publishers accepted for authority-tagged bootstrap reference inits. |
| `signer` | none | Required only for create/update operations. |
| `fetch` | global `fetch` | Custom fetch implementation for runtimes or tests. |

## Phase-2 Trust Model

Phase-2 references are bootstrap-published, but user-controlled:

```txt
owner.address = trusted bootstrap publisher
authority tag = user wallet
```

By default, the trusted bootstrap publisher is:

```txt
uAaRGha_a1ni_VjLf9Be2SFB7NJw1PWnjevdfeuJ_7c
```

`findReferences(authority)` accepts a reference init when:

```txt
authority tag == requested authority
AND
owner.address is either:
  - a trusted bootstrap publisher, or
  - the requested authority
```

This supports the current phase-2 bootstrap and future direct user-published
references while rejecting authority-tagged references from unknown publishers.

Reference and update discovery request 100 GraphQL edges per page and scan up to
100 pages by default. Low-level discovery helpers accept `maxPages` when a
caller wants a different scan cap.

## Low-Level Exports

The package also exports the pure pieces used by `ReferenceClient`:

```ts
import {
  buildInit,
  buildSet,
  currentState,
  effectiveValue,
  discoverSets,
  discoverReferencesByAuthority,
  fetchMessageById,
} from '@permaweb/references';
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
## License
This repository is license under the [MIT License](./LICENSE)

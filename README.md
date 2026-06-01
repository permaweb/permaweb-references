# @permaweb/names

TypeScript SDK for Permaweb Names references.

The SDK reads `reference@1.0` records from Arweave GraphQL, joins them with the
current phase-2 namespace snapshot, and can post reference updates through an
Arweave bundler. It is framework agnostic and has no Turbo dependency.

## Install

```bash
npm install @permaweb/names
```

Read-only usage does not need wallet dependencies. Writing with the built-in
signers needs the optional peer packages used by that signer:

```bash
npm install arweave arbundles
```

## Quick Start

```ts
import { ReferenceClient } from '@permaweb/names';

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
import { ReferenceClient, fromWallet } from '@permaweb/names';

const names = new ReferenceClient({
  signer: fromWallet(window.arweaveWallet),
});

await names.updateReference(referenceId, {
  value: 'NEW_TARGET_TX_ID',
});
```

### JWK

```ts
import { ReferenceClient, fromJwk } from '@permaweb/names';

const names = new ReferenceClient({
  signer: fromJwk(jwk),
  bundler: 'https://up.arweave.net',
});

await names.updateReference(referenceId, {
  value: 'NEW_TARGET_TX_ID',
});
```

The signer must be the reference authority.

## Create References

```ts
const { referenceId } = await names.createReference({
  authority: authorityAddress,
  value: targetTxId,
});
```

For user-created references, set `authority` to the controlling wallet address.
The resulting data item ID is the reference ID.

## Configuration

```ts
const names = new ReferenceClient({
  gateway: 'https://arweave.net',
  graphql: 'https://arweave.net/graphql',
  bundler: 'https://up.arweave.net',
  namespace: 'DmNd29cxXHDWuuSfVqCLJ8vKz8D0abctrADPPe0Vn60',
  trustedPublishers: [
    'gj49Uq4Hxwv-1IcJjrXT1OZaWkfPtqyqbdqadExs9mQ',
  ],
  fetch,
});
```

| Option | Default | Description |
| --- | --- | --- |
| `gateway` | `https://arweave.net` | Gateway used for tx reads and raw namespace fetches. |
| `graphql` | `${gateway}/graphql` | GraphQL endpoint used for reference discovery. |
| `bundler` | `https://up.arweave.net` | Bundler endpoint used by the JWK signer. |
| `namespace` | phase-2 namespace snapshot | Namespace manifest used to attach names to references. Set `null` to skip name lookup. |
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
gj49Uq4Hxwv-1IcJjrXT1OZaWkfPtqyqbdqadExs9mQ
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
} from '@permaweb/names';
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
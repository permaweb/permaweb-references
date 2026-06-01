# @permaweb/names

A developer utility for the `reference@1.0` AO-Core device. Read a reference's
current value from any Arweave gateway, and update a reference by posting a normal
Arweave tx to a bundler. Framework-agnostic TypeScript, no Turbo dependency.

## Read (GraphQL, any gateway)

```ts
import { ReferenceClient } from '@permaweb/names';

const refs = new ReferenceClient(); // defaults to arweave.net; pass { gateway } for any other

// current value of a reference
await refs.resolveReference(referenceId);   // -> the value

// full state
await refs.getReference(referenceId);
// -> { id, authority, value, timestamp, source: 'init' | 'set' } | undefined

// references controlled by an authority
await refs.findReferences(address); // -> reference ids
```

Reads are **stateless**: the client computes the current value from the reference's
`init` plus its updates, freshly each call. Caching/dedup/freshness are the
caller's concern (React Query/SWR on the frontend; the gateway/CDN and node on the
backend).

## Find references owned by a wallet

```ts
await refs.findReferences(walletAddress);
// -> [{ referenceId, name, value, nameSource?, dateRegistered? }]
```

Finds the `reference@1.0` references whose `authority` is that wallet (a GraphQL
query on the `authority` tag). `name` is pulled from the fixed namespace snapshot
(reverse `reference-id -> name`) and is `null` for references not in it. Point at a
different snapshot via `namespace`, or pass `namespace: null` to skip name lookup.

For phase-2 bootstrap refs, `findReferences` accepts inits only when the
`authority` tag matches the requested wallet and the publisher is trusted. By
default the trusted bootstrap publisher is
`gj49Uq4Hxwv-1IcJjrXT1OZaWkfPtqyqbdqadExs9mQ`; refs published directly by the
authority wallet are also accepted.

## Update (Arweave tx -> bundler)

```ts
import { ReferenceClient, fromWallet, fromJwk } from '@permaweb/names';

const refs = new ReferenceClient({
  signer: fromWallet(window.arweaveWallet),  // or fromJwk(jwk)
  // bundler defaults to https://up.arweave.net; override with your own
});

// create a new reference (its id is returned)
const { referenceId } = await refs.createReference({ value: targetId });

// update an existing reference (the signer must be its authority)
await refs.updateReference(referenceId, { value: newTargetId });
```

The signer builds a normal Arweave data item and POSTs it to the bundler. No Turbo
SDK; `arweave`/`arbundles` are lazy-loaded optional peers, so read-only use pulls
no crypto deps.

## Config

| option | default | purpose |
|--------|---------|---------|
| `gateway` | `https://arweave.net` | tx + GraphQL base (any gateway) |
| `graphql` | `${gateway}/graphql` | GraphQL endpoint |
| `bundler` | `https://up.arweave.net` | where updates are POSTed |
| `trustedPublishers` | phase-2 bootstrap publisher | allowed publishers for authority-tagged reference inits |
| `signer` | — | required only for updates |
| `fetch` | global | inject for node/tests |

## Low-level exports

The pure pieces are exported too: `buildInit` / `buildSet` (message builders),
`currentState` / `effectiveValue` (the §4 validity fold), `discoverSets`,
`discoverReferencesByAuthority`, `fetchMessageById`, and the `Signer` interface.

## Develop

```bash
npm install
npm test        # vitest; the §4 fold vectors are ported from the dev_reference EUnit suite
npm run build   # tsc -> dist (ESM)
```

## Not yet (step 3)

Name-level helpers, resolving a *name* and **listing names with their current
references**, depend on the namespace model and are deferred. The reference-level
read + update here is the foundation they build on.

`findReferences(authority)` is not a namespace listing API. It finds
`reference@1.0` ids controlled by an authority using explicit `authority` tags
and trusted publishers. Listing every name or subdomain should read the namespace manifest/state:
`GlobalNamespaceRoot -> NamespaceManifest -> name => RefID`.

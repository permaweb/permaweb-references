# @permaweb/references

TypeScript client for Permaweb Names and legacy `reference@1.0` records.

The mainnet names namespace now points at two kinds of entries:

- old `reference@1.0` ids
- `carrier@1.0` process ids, read from a HyperBEAM node

The client keeps those paths separate. Legacy references are resolved through Arweave GraphQL. Carrier-backed names are resolved from live process state.

## Install

```bash
npm install @permaweb/references
```

Read-only code does not need wallet packages. The built-in signers load their peers only when used:

```bash
npm install arweave arbundles
```

## Quick Start

```ts
import { ReferenceClient } from '@permaweb/references';

const names = new ReferenceClient();

const owned = await names.findNamesByOwner(
  '8s8ABYc_1oDZ553UKXLIzsUie48xc6V88Q1hPtky4C8',
);

const ao = await names.getName('ao');
```

## Reading

Resolve a name to its current target:

```ts
const value = await names.resolveName('ao');
```

Fetch the full name record:

```ts
const name = await names.getName('ao');

// {
//   name: string,
//   referenceId: string,
//   kind: 'reference' | 'carrier',
//   type: 'legacy-reference' | 'carrier',
//   authority?: string,
//   value: unknown,
//   timestamp?: number,
//   source?: 'init' | 'set' | 'process'
// }
```

Resolve or inspect a raw legacy reference:

```ts
const value = await names.resolveReference(referenceId);
const ref = await names.getReference(referenceId);
```

List legacy references controlled by an authority:

```ts
const refs = await names.findReferences(authorityAddress);
```

`findReferences` is not an "all names" API. It only returns reference records controlled by that authority. Use the namespace manifest/state directly when you need a full namespace scan.

List names controlled by a wallet in the configured namespace:

```ts
const owned = await names.findNamesByOwner(authorityAddress);

// [
//   {
//     name: string,
//     referenceId: string,
//     namespaceId: string,
//     kind: 'reference' | 'carrier',
//     type: 'legacy-reference' | 'carrier',
//     value: unknown,
//     ownership?: 'owned' | 'escrowed',
//     authority?: string,
//     processId?: string,
//     saleOrder?: SwapOrder
//   }
// ]
```

For owner pages, stream verified results as carrier state checks finish:

```ts
const final = await names.streamNamesByOwner(
  ownerAddress,
  (names) => render(names),
  {
    types: ['legacy-reference', 'carrier'],
    maxAttempts: 4,
    onCarrierError: (error, carrier) => console.warn(carrier.name, error),
  },
);
```

For carrier-backed names, `findNamesByOwner` discovers candidate process ids from GraphQL, then checks live carrier state with bounded concurrency and retries. Final ownership comes from live balances and live sale escrow state, not spawn tags. If the carrier unit is escrowed in a live sale order, the seller is returned with `ownership: 'escrowed'` and `saleOrder`.

Slow or unavailable carrier reads are skipped rather than treated as ownership. Pass `types: 'carrier'` when you do not need legacy references, or `types: 'legacy-reference'` when you do not need carriers. Pass `concurrency`, `maxAttempts`, `requestTimeout`, `retryBaseDelay`, `carrierReadPath`, or `onCarrierError` when you need tighter control or diagnostics.

## Writing Legacy References

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

The signer must be the reference authority. `updateReference` reads the current reference first and does not post if the signer is not allowed to update it.

When no timestamp is passed, the client uses:

```ts
Math.max(Date.now(), latestTimestamp + 1)
```

Pass `timestamp` yourself only when you need to control that nonce.

Create a new reference:

```ts
const { referenceId } = await names.createReference({
  value: targetTxId,
});
```

For user-created references, `authority` defaults to the signer address. Bootstrap publishers can pass an explicit `authority` for another wallet. The signed data item id becomes the reference id.

## Writing Carriers

Carrier-backed names are process transactions, not bundled reference messages. A target update is a data-free L1 Arweave transaction:

```txt
target=<process-id>
quantity=1
action=set
reference-value=<new target>
```

Use the same wallet signer:

```ts
import { ReferenceClient, fromWallet } from '@permaweb/references';

const names = new ReferenceClient({
  signer: fromWallet(window.arweaveWallet),
  gateway: 'https://arweave.net',
  node: 'https://state-1.forward.computer',
});

await names.setCarrierTarget(processId, targetTxId);
await names.transferCarrier(processId, recipientAddress);
await names.makeCarrierOffer(processId, { asking: '1000000000000' });
```

`fromWallet(window.arweaveWallet)` uses `wallet.sign` for carrier calls, so it works with ArConnect/Wander-style wallets. Before posting, it checks that the signed transaction has no data and that the owner is the expected signer.

Swap helpers:

```ts
await names.makeCarrierOrder(processId, { asking: '1000000000000' });
await names.cancelCarrierOrder(processId, order.orderId);
const costs = await names.estimateCarrierPurchaseCosts(order, processId);
const balance = await names.walletBalance(buyerAddress);
const reservationId = await names.findCarrierReservationTransaction(processId, order.orderId, buyerAddress);
await names.registerCarrierInterest(processId, order);
await names.payCarrierOrder(processId, order);
await names.buyCarrierOrder(processId, order);
```

Before signing, carrier writes read live state from `node`:

- set, transfer, and offer creation require `balances[signer] === "1"`
- payment requires the order to be reserved for the signer
- the reservation must cover `currentHeight + inclusionMargin`
- open-order `buyCarrierOrder` registers interest, waits for the live reservation, then pays
- swap transactions check wallet balance against AR quantity plus quoted L1 fees
- `/info`, `/price/0/<target>`, and `/wallet/<address>/balance` must return valid values
- process ids, targets, and recipients must be valid 43-character Arweave ids

## Configuration

```ts
const names = new ReferenceClient({
  gateway: 'https://arweave.net',
  graphql: 'https://arweave.net/graphql',
  node: 'https://state-1.forward.computer',
  bundler: 'https://up.arweave.net',
  namespace: 'fQXYPE9MAcfI1wV2CwJ3sJIhgT9btBOlYFOKFDGhAs0',
  trustedPublishers: [
    'uAaRGha_a1ni_VjLf9Be2SFB7NJw1PWnjevdfeuJ_7c',
  ],
  fetch,
});
```

| Option | Default | Notes |
| --- | --- | --- |
| `gateway` | `https://arweave.net` | Transaction reads, raw namespace fetches, L1 transaction posts, fee quotes, and wallet balance checks. |
| `graphql` | `${gateway}/graphql` | Reference and carrier discovery. |
| `node` | `gateway` | HyperBEAM/gateway origin for carrier state reads. |
| `carrierReadPath` | `['now', 'compute']` | Carrier process state path or ordered fallback paths. |
| `bundler` | `https://up.arweave.net` | Used by JWK reference writes. |
| `namespace` | mainnet names namespace root | Set `null` to skip name lookup. |
| `trustedPublishers` | phase-2 bootstrap publisher | Accepted publishers for authority-tagged bootstrap reference inits. |
| `signer` | none | Required for writes. |
| `fetch` | global `fetch` | Pass one in runtimes without a global fetch, or in tests. |

## Mainnet Namespace

Default namespace:

```txt
fQXYPE9MAcfI1wV2CwJ3sJIhgT9btBOlYFOKFDGhAs0
```

For carrier-backed names, the namespace manifest maps `name -> process id`. The client checks that the process was spawned with `carrier@1.0`, then reads:

```txt
/<process-id>~process@1.0/now
```

If `/now` fails, the default reader tries `/compute`. To force one path, pass `carrierReadPath: 'now'` or call `readCarrierState(processId, { provider, fetch, path: 'now' })`.

Marketplace listing hydration retries carrier reads by default. Pass `maxAttempts`, `retryBaseDelay`, or `onRetry` when you want tighter control or progress updates.

The current holder is the address with balance `1`. If the unit is escrowed in a live swap order, the seller is treated as the owner until settlement and owner results include `ownership: 'escrowed'`.

## Phase-2 Trust Model

Phase-2 references were bootstrap-published, but remain user-controlled:

```txt
owner.address = trusted bootstrap publisher
authority tag = user wallet
```

Default trusted publisher:

```txt
uAaRGha_a1ni_VjLf9Be2SFB7NJw1PWnjevdfeuJ_7c
```

`findReferences(authority)` accepts an init when the authority tag matches the requested authority and the owner is either the requested authority or a trusted bootstrap publisher.

Discovery reads 100 GraphQL edges per page and scans up to 100 pages by default. Low-level discovery helpers accept `maxPages` when callers need a different cap.

## Low-Level Exports

The package exports the pure helpers used by `ReferenceClient`:

```ts
import {
  buildInit,
  buildSet,
  buildCarrierSetTarget,
  buildCarrierTransfer,
  currentState,
  effectiveValue,
  discoverSets,
  discoverReferencesByAuthority,
  fetchMessageById,
  findReservationTransaction,
  normalizeServingNodeOrigin,
  parseNamesNamespace,
  readCarrierState,
  servingNodeOrigin,
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

MIT

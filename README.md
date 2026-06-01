# @permaweb/names

A trustless JS client for the `reference@1.0` AO-Core device: resolve and manage
permaweb names from any frontend, no trusted scheduler. Lives inside the
permaweb-names repo and is its first consumer. (Package name is a placeholder,
rename before publishing.)

## Status

**Phase 1 (this commit): pure core, no network or wallet.**

- `messages` — `buildInit` / `buildSet` / `buildPointer` (§3, §9)
- `identity` — `isInit`, `authorityOf`, `referenceIdOf` (§2)
- `compute` — `currentState` (the §4 validity/ordering fold), `effectiveValue` (§3), `resolveValue`

Conformance tests are ported from the Erlang `dev_reference` EUnit suite
(init-only, latest-set, stale-set-ignored, wrong-authority-ignored, tie-break by
data-layer position, reference-set directory update).

## Planned

- `discovery` — GraphQL set discovery (§8)
- `ReferenceClient` — trustless resolve + `list` / `lookup` / `namesByOwner` (§5, §9)
- `verify` — opt-in client-side commitment verification via a `verify` flag (§4, §10);
  off by default (the gateway is the trusted, decentralizing layer)
- write path — signer (`window.arweaveWallet` / JWK) + `createReference` / `setReference` / `registerName`
- React adapter — `useName`, `useList`, `useNamesByOwner`, `useSetReference`

## Develop

```bash
cd packages/names
npm install
npm test
```

## Phase-1 usage

```ts
import { buildSet, currentState, effectiveValue } from '@permaweb/names';

// build a set message to dispatch (signing/dispatch lands with the signer)
const { tags } = buildSet({ referenceId, value: targetId, timestamp: Date.now() });

// compute a reference's current value locally from discovered sets
const state = currentState({ init, authority, candidates });
const value = effectiveValue(state.message);
```

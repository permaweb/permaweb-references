import type { Address, Candidate, ReferenceMessage } from './types.js';
import { isInit } from './identity.js';
import { DEVICE } from './messages.js';

export const PHASE2_BOOTSTRAP_OWNER = 'gj49Uq4Hxwv-1IcJjrXT1OZaWkfPtqyqbdqadExs9mQ';

export interface GqlNode {
	id: string;
	owner?: { address?: string };
	tags?: { name: string; value: string }[];
	block?: { height?: number } | null;
}

/** Reconstruct a reference message from a tx's tags (scalar keys: ids, timestamp). */
export function tagsToMessage(tags: { name: string; value: string }[] = []): ReferenceMessage {
	const message: ReferenceMessage = {};
	for (const t of tags) message[t.name] = t.value;
	return message;
}

/**
 * A GraphQL node becomes a fold Candidate. Committers come from the gateway's
 * `owner.address` (trusted unless `verify` re-checks the signature). Unconfirmed
 * txs (no block) sort last so confirmed history orders first; a higher timestamp
 * still wins regardless, since position only breaks ties (§4).
 */
export function nodeToCandidate(node: GqlNode, index: number): Candidate {
	return {
		message: tagsToMessage(node.tags),
		committers: node.owner?.address ? [node.owner.address] : [],
		position: { block: node.block?.height ?? Number.MAX_SAFE_INTEGER, index },
		id: node.id,
	};
}

export interface SetQueryArgs {
	referenceId: string;
	authority?: Address;
	minBlock?: number;
	first?: number;
	after?: string;
}

/** The §8 discovery query: device=reference@1.0 AND reference-id, owner-scoped, HEIGHT_ASC. */
export function buildSetQuery(args: SetQueryArgs): string {
	const { referenceId, authority, minBlock = 0, first = 100, after } = args;
	const owners = authority ? `owners: ${JSON.stringify([authority])}, ` : '';
	const afterArg = after ? `, after: ${JSON.stringify(after)}` : '';
	return `query {
  transactions(
    ${owners}tags: [
      { name: "device", values: ${JSON.stringify([DEVICE])} },
      { name: "reference-id", values: ${JSON.stringify([referenceId])} }
    ],
    block: { min: ${minBlock} },
    sort: HEIGHT_ASC,
    first: ${first}${afterArg}
  ) {
    pageInfo { hasNextPage }
    edges { cursor node { id owner { address } tags { name value } block { height } } }
  }
}`;
}

/** Fetch a single tx (the `init`) by id. */
export function buildTxQuery(id: string): string {
	return `query { transaction(id: ${JSON.stringify(id)}) { id owner { address } tags { name value } block { height } } }`;
}

export async function gqlRequest(endpoint: string, query: string, fetchImpl: typeof fetch): Promise<any> {
	const res = await fetchImpl(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ query }),
	});
	if (!res.ok) throw new Error(`GraphQL request failed: ${res.status} ${res.statusText} (${endpoint})`);
	const json: any = await res.json();
	if (json?.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 200)}`);
	return json?.data;
}

export interface DiscoverArgs {
	endpoint: string;
	fetch: typeof fetch;
	referenceId: string;
	authority?: Address;
	minBlock?: number;
	maxPages?: number;
}

/** Discover all candidate `set`s for a reference, paginating in data-layer order. */
export async function discoverSets(args: DiscoverArgs): Promise<Candidate[]> {
	const { endpoint, fetch: f, referenceId, authority, minBlock = 0, maxPages = 20 } = args;
	const out: Candidate[] = [];
	let after: string | undefined;
	let index = 0;
	for (let page = 0; page < maxPages; page++) {
		const data = await gqlRequest(endpoint, buildSetQuery({ referenceId, authority, minBlock, after }), f);
		const edges: { cursor: string; node: GqlNode }[] = data?.transactions?.edges ?? [];
		for (const e of edges) {
			after = e.cursor;
			const candidate = nodeToCandidate(e.node, index++);
			if (candidate.message.device !== DEVICE) continue;
			if (candidate.message['reference-id'] !== referenceId) continue;
			out.push(candidate);
		}
		if (edges.length === 0 || !data?.transactions?.pageInfo?.hasNextPage) break;
	}
	return out;
}

export interface FetchedMessage {
	message: ReferenceMessage;
	committers: Address[];
	block: number;
}

export async function fetchMessageById(args: { endpoint: string; fetch: typeof fetch; id: string }): Promise<FetchedMessage | undefined> {
	const data = await gqlRequest(args.endpoint, buildTxQuery(args.id), args.fetch);
	const node: GqlNode | undefined = data?.transaction;
	if (!node) return undefined;
	return {
		message: tagsToMessage(node.tags),
		committers: node.owner?.address ? [node.owner.address] : [],
		block: node.block?.height ?? 0,
	};
}

export interface DiscoveredReference {
	id: string;
	message: ReferenceMessage;
	owner?: Address;
}

/** Find bootstrap inits that explicitly carry `authority=<authority>`. */
export function buildAuthorityInitsQuery(args: { authority: Address; first?: number; after?: string }): string {
	const { authority, first = 100, after } = args;
	const afterArg = after ? `, after: ${JSON.stringify(after)}` : '';
	return `query {
  transactions(
    tags: [
      { name: "device", values: ${JSON.stringify([DEVICE])} },
      { name: "authority", values: ${JSON.stringify([authority])} }
    ],
    sort: HEIGHT_DESC,
    first: ${first}${afterArg}
  ) { pageInfo { hasNextPage } edges { cursor node { id owner { address } tags { name value } } } }
}`;
}

/** @deprecated Use buildAuthorityInitsQuery. */
export function buildAuthorityQuery(args: { authority: Address; first?: number; after?: string }): string {
	return buildAuthorityInitsQuery(args);
}

/**
 * References a wallet controls. Valid phase-2 refs must carry
 * `authority=<wallet>` and be published by either:
 *
 * - the phase-2 bootstrap publisher; or
 * - the authority itself, for future user-created refs.
 *
 * GQL is discovery only. Each candidate is reconstructed and kept only when it
 * is a true reference init whose authority tag and publisher match.
 */
export async function discoverReferencesByAuthority(args: {
	endpoint: string;
	fetch: typeof fetch;
	authority: Address;
	maxPages?: number;
	trustedPublishers?: Address[];
}): Promise<DiscoveredReference[]> {
	const { endpoint, fetch: f, authority, maxPages = 20, trustedPublishers = [PHASE2_BOOTSTRAP_OWNER] } = args;
	const refs = new Map<string, DiscoveredReference>();

	await collectReferenceInits({
		endpoint,
		fetch: f,
		buildQuery: (after?: string) => buildAuthorityInitsQuery({ authority, after }),
		authority,
		trustedPublishers,
		refs,
		maxPages,
	});

	return [...refs.values()];
}

/** @deprecated Use discoverReferencesByAuthority. */
export async function discoverInitsByOwner(args: { endpoint: string; fetch: typeof fetch; owner: Address; maxPages?: number }): Promise<string[]> {
	const refs = await discoverReferencesByAuthority({
		endpoint: args.endpoint,
		fetch: args.fetch,
		authority: args.owner,
		maxPages: args.maxPages,
	});
	return refs.map((ref) => ref.id);
}

async function collectReferenceInits(args: {
	endpoint: string;
	fetch: typeof fetch;
	buildQuery: (after?: string) => string;
	authority: Address;
	trustedPublishers: Address[];
	refs: Map<string, DiscoveredReference>;
	maxPages: number;
}): Promise<void> {
	const { endpoint, fetch: f, buildQuery, authority, trustedPublishers, refs, maxPages } = args;
	const allowedPublishers = new Set([authority, ...trustedPublishers]);
	let after: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const data = await gqlRequest(endpoint, buildQuery(after), f);
		const edges: { cursor: string; node: GqlNode }[] = data?.transactions?.edges ?? [];
		for (const e of edges) {
			const message = tagsToMessage(e.node.tags);
			const owner = e.node.owner?.address;
			if (
				message.device === DEVICE &&
				isInit(message) &&
				message.authority === authority &&
				owner !== undefined &&
				allowedPublishers.has(owner)
			) {
				refs.set(e.node.id, { id: e.node.id, message, owner });
			}
			after = e.cursor;
		}
		if (edges.length === 0 || !data?.transactions?.pageInfo?.hasNextPage) break;
	}
}

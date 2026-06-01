import type { Address, Candidate, ReferenceMessage } from './types.js';
import { DEVICE } from './messages.js';

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
			out.push(nodeToCandidate(e.node, index++));
			after = e.cursor;
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

export function buildOwnerInitsQuery(args: { owner: Address; first?: number; after?: string }): string {
	const { owner, first = 100, after } = args;
	const afterArg = after ? `, after: ${JSON.stringify(after)}` : '';
	return `query {
  transactions(
    owners: ${JSON.stringify([owner])},
    tags: [ { name: "device", values: ${JSON.stringify([DEVICE])} } ],
    sort: HEIGHT_ASC,
    first: ${first}${afterArg}
  ) { pageInfo { hasNextPage } edges { cursor node { id tags { name value } } } }
}`;
}

/**
 * Reference ids the `owner` authored as `init`s (a reference@1.0 message with no
 * `reference-id` tag). Used to find which directory names map to references the
 * owner controls (the per-name-reference / scenario-2 model).
 */
export async function discoverInitsByOwner(args: { endpoint: string; fetch: typeof fetch; owner: Address; maxPages?: number }): Promise<string[]> {
	const { endpoint, fetch: f, owner, maxPages = 20 } = args;
	const ids: string[] = [];
	let after: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const data = await gqlRequest(endpoint, buildOwnerInitsQuery({ owner, after }), f);
		const edges: { cursor: string; node: GqlNode }[] = data?.transactions?.edges ?? [];
		for (const e of edges) {
			const tags = e.node.tags ?? [];
			if (!tags.some((t) => t.name === 'reference-id')) ids.push(e.node.id);
			after = e.cursor;
		}
		if (edges.length === 0 || !data?.transactions?.pageInfo?.hasNextPage) break;
	}
	return ids;
}

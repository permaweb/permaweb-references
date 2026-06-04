import { describe, it, expect } from 'vitest';
import {
	buildAuthorityInitsQuery,
	buildSetQuery,
	buildTxQuery,
	tagsToMessage,
	nodeToCandidate,
	discoverReferencesByAuthority,
	discoverSets,
	PHASE2_BOOTSTRAP_OWNER,
} from '../src/discovery';
import type { GqlNode } from '../src/discovery';

const node = (id: string, owner: string, tags: Record<string, string>, block?: number): GqlNode => ({
	id,
	owner: { address: owner },
	tags: Object.entries(tags).map(([name, value]) => ({ name, value })),
	block: block !== undefined ? { height: block } : null,
});

describe('buildSetQuery / §8', () => {
	it('filters by reference-id, scopes to the authority, and sorts ascending', () => {
		const q = buildSetQuery({ referenceId: 'R', authority: 'AUTH', minBlock: 7 });
		expect(q).not.toContain('"device"');
		expect(q).not.toContain('reference@1.0');
		expect(q).toContain('"reference-id"');
		expect(q).toContain('"R"');
		expect(q).toContain('owners: ["AUTH"]');
		expect(q).toContain('block: { min: 7 }');
		expect(q).toContain('sort: HEIGHT_ASC');
	});

	it('omits the owners filter when no authority is given', () => {
		expect(buildSetQuery({ referenceId: 'R' })).not.toContain('owners:');
	});

	it('escapes interpolated ids (no GraphQL injection)', () => {
		const q = buildSetQuery({ referenceId: 'a" b', authority: 'x"y' });
		expect(q).toContain('["a\\" b"]');
		expect(q).toContain('["x\\"y"]');
	});
});

describe('buildAuthorityInitsQuery', () => {
	it('finds bootstrap inits by explicit authority tag without relying on device lookup', () => {
		const q = buildAuthorityInitsQuery({ authority: 'AUTH' });
		expect(q).not.toContain('"device"');
		expect(q).not.toContain('reference@1.0');
		expect(q).toContain('"authority"');
		expect(q).toContain('"AUTH"');
	});
});

describe('buildTxQuery', () => {
	it('queries a single transaction by id', () => {
		expect(buildTxQuery('R')).toContain('transaction(id: "R")');
	});
});

describe('tagsToMessage / nodeToCandidate', () => {
	it('reconstructs a message from tags', () => {
		expect(tagsToMessage([{ name: 'device', value: 'reference@1.0' }, { name: 'timestamp', value: '5' }])).toEqual({
			device: 'reference@1.0',
			timestamp: '5',
		});
	});

	it('maps owner -> committers and block -> position', () => {
		const c = nodeToCandidate(node('id1', 'OWNER', { device: 'reference@1.0', timestamp: '3' }, 100), 4);
		expect(c.committers).toEqual(['OWNER']);
		expect(c.position).toEqual({ block: 100, index: 4 });
		expect(c.message.timestamp).toBe('3');
		expect(c.id).toBe('id1');
	});

	it('sorts unconfirmed (no block) txs last', () => {
		const c = nodeToCandidate(node('id2', 'OWNER', {}), 0);
		expect(c.position.block).toBe(Number.MAX_SAFE_INTEGER);
	});
});

describe('discoverSets pagination', () => {
	it('walks every page and assigns a running index', async () => {
		const pages = [
			{
				hasNextPage: true,
				edges: [
					{ cursor: 'c0', node: node('a', 'O', { device: 'reference@1.0', 'reference-id': 'R' }, 1) },
					{ cursor: 'c1', node: node('b', 'O', { device: 'reference@1.0', 'reference-id': 'R' }, 2) },
				],
			},
			{ hasNextPage: false, edges: [{ cursor: 'c2', node: node('c', 'O', { device: 'reference@1.0', 'reference-id': 'R' }, 3) }] },
		];
		let call = 0;
		const fetchImpl = (async () => {
			const page = pages[Math.min(call, pages.length - 1)]!;
			call++;
			return new Response(JSON.stringify({ data: { transactions: { pageInfo: { hasNextPage: page.hasNextPage }, edges: page.edges } } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;

		const out = await discoverSets({ endpoint: 'https://gw/graphql', fetch: fetchImpl, referenceId: 'R', authority: 'O' });
		expect(call).toBe(2);
		expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c']);
		expect(out.map((c) => c.position.index)).toEqual([0, 1, 2]);
	});

	it('honors an explicit maxPages cap', async () => {
		let call = 0;
		const fetchImpl = (async () => {
			call++;
			return new Response(
				JSON.stringify({
					data: {
						transactions: {
							pageInfo: { hasNextPage: true },
							edges: [{ cursor: `c${call}`, node: node(`id-${call}`, 'O', { device: 'reference@1.0', 'reference-id': 'R' }, call) }],
						},
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as unknown as typeof fetch;

		const out = await discoverSets({ endpoint: 'https://gw/graphql', fetch: fetchImpl, referenceId: 'R', authority: 'O', maxPages: 2 });
		expect(call).toBe(2);
		expect(out.map((c) => c.id)).toEqual(['id-1', 'id-2']);
	});

	it('re-checks reference-id locally and treats the reference device tag as optional', async () => {
		const edges = [
			{ cursor: 'c0', node: node('wrong-ref', 'O', { device: 'reference@1.0', 'reference-id': 'OTHER' }, 1) },
			{ cursor: 'c1', node: node('wrong-device', 'O', { device: 'other@1.0', 'reference-id': 'R' }, 2) },
			{ cursor: 'c2', node: node('ok-old', 'O', { device: 'reference@1.0', 'reference-id': 'R' }, 3) },
			{ cursor: 'c3', node: node('ok-new', 'O', { 'reference-id': 'R' }, 4) },
		];
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ data: { transactions: { pageInfo: { hasNextPage: false }, edges } } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})) as unknown as typeof fetch;

		const out = await discoverSets({ endpoint: 'https://gw/graphql', fetch: fetchImpl, referenceId: 'R', authority: 'O' });
		expect(out.map((c) => c.id)).toEqual(['ok-old', 'ok-new']);
	});
});

describe('discoverReferencesByAuthority', () => {
	it('finds bootstrap-published and user-published refs with matching authority tags', async () => {
		const ownerSigned = node('owned-init', 'AUTH', { device: 'reference@1.0', authority: 'AUTH' }, 1);
		const bootstrapSigned = node('bootstrap-init', PHASE2_BOOTSTRAP_OWNER, { device: 'reference@1.0', authority: 'AUTH' }, 2);
		const setByAuth = node('not-init', 'AUTH', { device: 'reference@1.0', 'reference-id': 'R' }, 3);
		const otherAuthority = node('other-auth', PHASE2_BOOTSTRAP_OWNER, { device: 'reference@1.0', authority: 'OTHER' }, 4);
		const unexpectedPublisher = node('unexpected-publisher', 'EVIL', { device: 'reference@1.0', authority: 'AUTH' }, 5);
		const missingAuthority = node('missing-authority', 'AUTH', { device: 'reference@1.0' }, 6);

		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			return new Response(
				JSON.stringify({
					data: {
						transactions: {
							pageInfo: { hasNextPage: false },
							edges: [bootstrapSigned, ownerSigned, setByAuth, otherAuthority, unexpectedPublisher, missingAuthority].map((n, i) => ({
								cursor: `c${i}`,
								node: n,
							})),
						},
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as unknown as typeof fetch;

		const refs = await discoverReferencesByAuthority({ endpoint: 'https://gw/graphql', fetch: fetchImpl, authority: 'AUTH' });
		expect(refs.map((r) => r.id).sort()).toEqual(['bootstrap-init', 'owned-init']);
	});
});

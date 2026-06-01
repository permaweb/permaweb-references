import { describe, it, expect } from 'vitest';
import { buildSetQuery, buildTxQuery, tagsToMessage, nodeToCandidate, discoverSets } from '../src/discovery';
import type { GqlNode } from '../src/discovery';

const node = (id: string, owner: string, tags: Record<string, string>, block?: number): GqlNode => ({
	id,
	owner: { address: owner },
	tags: Object.entries(tags).map(([name, value]) => ({ name, value })),
	block: block !== undefined ? { height: block } : null,
});

describe('buildSetQuery / §8', () => {
	it('filters by device + reference-id, scopes to the authority, and sorts ascending', () => {
		const q = buildSetQuery({ referenceId: 'R', authority: 'AUTH', minBlock: 7 });
		expect(q).toContain('"device"');
		expect(q).toContain('reference@1.0');
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
			{ hasNextPage: true, edges: [{ cursor: 'c0', node: node('a', 'O', {}, 1) }, { cursor: 'c1', node: node('b', 'O', {}, 2) }] },
			{ hasNextPage: false, edges: [{ cursor: 'c2', node: node('c', 'O', {}, 3) }] },
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
});

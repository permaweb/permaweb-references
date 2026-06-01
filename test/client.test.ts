import { describe, it, expect } from 'vitest';
import { ReferenceClient } from '../src/client';
import { PHASE2_BOOTSTRAP_OWNER, type GqlNode } from '../src/discovery';

const node = (id: string, owner: string, tags: Record<string, string>, block?: number): GqlNode => ({
	id,
	owner: { address: owner },
	tags: Object.entries(tags).map(([name, value]) => ({ name, value })),
	block: block !== undefined ? { height: block } : null,
});

/** Mock gateway: answers `transaction(id:)` with `init`, `transactions(` with `sets`. */
function gateway(opts: { init?: GqlNode; sets?: GqlNode[] }) {
	let calls = 0;
	const fetchImpl = (async (_url: string, init?: RequestInit) => {
		calls++;
		const q = JSON.parse(String(init?.body)).query as string;
		const data = q.includes('transaction(id:')
			? { transaction: opts.init ?? null }
			: { transactions: { pageInfo: { hasNextPage: false }, edges: (opts.sets ?? []).map((n, i) => ({ cursor: `c${i}`, node: n })) } };
		return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls: () => calls };
}

const REF = 'REF';
const init = node(REF, 'A', { device: 'reference@1.0', 'reference-value': 'BASE' });
const setMsg = (owner: string, ts: number, value: string, block: number) =>
	node(`s-${ts}`, owner, { device: 'reference@1.0', 'reference-id': REF, timestamp: String(ts), 'reference-value': value }, block);

describe('ReferenceClient.resolveReference', () => {
	it('folds discovered sets to the latest value', async () => {
		const gw = gateway({ init, sets: [setMsg('A', 2, 'V2', 100), setMsg('A', 3, 'V3', 101)] });
		const client = new ReferenceClient({ fetch: gw.fetch });
		expect(await client.resolveReference(REF)).toBe('V3');
	});

	it('ignores a set from the wrong authority', async () => {
		const gw = gateway({ init, sets: [setMsg('IMPOSTER', 99, 'HAX', 100)] });
		const client = new ReferenceClient({ fetch: gw.fetch });
		expect(await client.resolveReference(REF)).toBe('BASE');
	});

	it('returns the init value when there are no sets', async () => {
		const gw = gateway({ init, sets: [] });
		const client = new ReferenceClient({ fetch: gw.fetch });
		const ref = await client.getReference(REF);
		expect(ref?.source).toBe('init');
		expect(ref?.value).toBe('BASE');
		expect(ref?.authority).toBe('A');
	});

	it('is stateless: re-fetches on every call (caching is the caller\'s job)', async () => {
		const gw = gateway({ init, sets: [setMsg('A', 2, 'V2', 100)] });
		const client = new ReferenceClient({ fetch: gw.fetch });
		await client.resolveReference(REF);
		const afterFirst = gw.calls();
		await client.resolveReference(REF);
		expect(gw.calls()).toBeGreaterThan(afterFirst);
	});

	it('returns undefined for an unknown reference', async () => {
		const gw = gateway({ init: undefined, sets: [] });
		const client = new ReferenceClient({ fetch: gw.fetch });
		expect(await client.getReference('missing')).toBeUndefined();
	});

	it('returns undefined when the id is not a reference init', async () => {
		const gw = gateway({ init: node('not-ref', 'A', { device: 'other@1.0', 'reference-value': 'BASE' }), sets: [] });
		const client = new ReferenceClient({ fetch: gw.fetch });
		expect(await client.getReference('not-ref')).toBeUndefined();
	});
});

describe('ReferenceClient config', () => {
	it('defaults to arweave.net gateway + up.arweave.net bundler, both overridable', () => {
		const def = new ReferenceClient({ fetch: gateway({}).fetch });
		expect(def.graphql).toBe('https://arweave.net/graphql');
		expect(def.bundler).toBe('https://up.arweave.net');
		const custom = new ReferenceClient({ fetch: gateway({}).fetch, gateway: 'https://my.gw', bundler: 'https://my.bundler/~bundler@1.0/tx' });
		expect(custom.graphql).toBe('https://my.gw/graphql');
		expect(custom.bundler).toBe('https://my.bundler/~bundler@1.0/tx');
	});
});

describe('ReferenceClient.findReferences', () => {
	it('delegates to authority-based reference discovery', async () => {
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			const nodes = [
				node('owned-init', 'AUTH', { device: 'reference@1.0', authority: 'AUTH' }),
				node('bootstrap-init', PHASE2_BOOTSTRAP_OWNER, { device: 'reference@1.0', authority: 'AUTH' }),
			];
			return new Response(
				JSON.stringify({
					data: {
						transactions: {
							pageInfo: { hasNextPage: false },
							edges: nodes.map((n, i) => ({ cursor: `c${i}`, node: n })),
						},
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as unknown as typeof fetch;

		const client = new ReferenceClient({ fetch: fetchImpl, namespace: null });
		expect((await client.findReferences('AUTH')).map((ref) => ref.referenceId)).toEqual(['owned-init', 'bootstrap-init']);
	});
});

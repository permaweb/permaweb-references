import { describe, it, expect } from 'vitest';
import { ReferenceClient } from '../src/client';
import { PHASE2_BOOTSTRAP_OWNER, type GqlNode } from '../src/discovery';

const ref = (id: string, authority: string, value: string, extra: Record<string, string> = {}): GqlNode => ({
	id,
	owner: { address: PHASE2_BOOTSTRAP_OWNER },
	tags: Object.entries({ device: 'reference@1.0', authority, 'reference-value': value, ...extra }).map(([name, v]) => ({ name, value: v })),
});

function gateway(opts: { refs: GqlNode[]; namespace: object }) {
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		if (String(url).includes('/raw/')) {
			return new Response(JSON.stringify(opts.namespace), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		const data = { transactions: { pageInfo: { hasNextPage: false }, edges: opts.refs.map((n, i) => ({ cursor: `c${i}`, node: n })) } };
		return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return fetchImpl;
}

describe('findReferences', () => {
	it('returns references controlled by an authority, with names from the namespace', async () => {
		const refs = [
			ref('REF_alice', 'ME', 'TARGET_alice', { 'name-source': 'arns', 'date-registered': '2024-01-01T00:00:00Z' }),
			ref('REF_unknown', 'ME', 'TARGET_x'),
		];
		const namespace = { manifest: 'arweave/paths', paths: { alice: { id: 'REF_alice' } } };
		const client = new ReferenceClient({ fetch: gateway({ refs, namespace }), namespace: 'NS_ID' });

		const out = await client.findReferences('ME');
		expect(out.length).toBe(2);
		expect(out[0]).toMatchObject({ referenceId: 'REF_alice', name: 'alice', value: 'TARGET_alice', nameSource: 'arns', dateRegistered: '2024-01-01T00:00:00Z' });
		expect(out[1]).toMatchObject({ referenceId: 'REF_unknown', name: null, value: 'TARGET_x' });
	});

	it('skips sets (returns only the reference inits)', async () => {
		const set = ref('S1', 'ME', 'V');
		set.tags!.push({ name: 'reference-id', value: 'REF_alice' });
		const client = new ReferenceClient({ fetch: gateway({ refs: [set], namespace: { paths: {} } }), namespace: 'NS' });
		expect(await client.findReferences('ME')).toEqual([]);
	});

	it('attaches no names when the namespace is disabled', async () => {
		const refs = [ref('REF_a', 'ME', 'T')];
		const client = new ReferenceClient({ fetch: gateway({ refs, namespace: {} }), namespace: null });
		const out = await client.findReferences('ME');
		expect(out[0]).toMatchObject({ referenceId: 'REF_a', name: null });
	});
});

import { describe, it, expect } from 'vitest';
import { parseManifest, listEntries, lookupEntry } from '../src/directory';
import { ReferenceClient } from '../src/client';
import type { GqlNode } from '../src/discovery';

describe('parseManifest', () => {
	it('extracts paths from an arweave manifest', () => {
		const dir = parseManifest(JSON.stringify({ manifest: 'arweave/paths', version: '0.2.0', paths: { alice: { id: 'T_a' } } }));
		expect(dir.paths).toEqual({ alice: { id: 'T_a' } });
	});

	it('tolerates a document with no paths', () => {
		expect(parseManifest(JSON.stringify({ hello: 'world' })).paths).toEqual({});
	});
});

const paths = { bob: { id: 'T_bob' }, alice: { id: 'T_alice' }, 'alice-app': { id: 'R_owned' } };

describe('listEntries (pure)', () => {
	it('lists names sorted', () => {
		expect(listEntries(paths).entries.map((e) => e.name)).toEqual(['alice', 'alice-app', 'bob']);
	});

	it('filters by search', () => {
		expect(listEntries(paths, { search: 'alice' }).entries.map((e) => e.name)).toEqual(['alice', 'alice-app']);
	});

	it('paginates with a cursor', () => {
		const page1 = listEntries(paths, { limit: 2 });
		expect(page1.entries.map((e) => e.name)).toEqual(['alice', 'alice-app']);
		expect(page1.total).toBe(3);
		expect(page1.nextCursor).toBe(2);
		const page2 = listEntries(paths, { limit: 2, cursor: page1.nextCursor });
		expect(page2.entries.map((e) => e.name)).toEqual(['bob']);
		expect(page2.nextCursor).toBeUndefined();
	});
});

describe('lookupEntry (pure)', () => {
	it('returns the entry or null', () => {
		expect(lookupEntry(paths, 'bob')).toEqual({ name: 'bob', id: 'T_bob' });
		expect(lookupEntry(paths, 'nope')).toBeNull();
	});
});

// --- end-to-end through a mocked gateway: namespace ref -> manifest id -> names ---

const node = (id: string, owner: string, tags: Record<string, string>): GqlNode => ({
	id,
	owner: { address: owner },
	tags: Object.entries(tags).map(([name, value]) => ({ name, value })),
	block: { height: 1 },
});

const NS = 'NS';
const MANIFEST = 'MANIFEST_ID';
const namespaceInit = node(NS, 'gj49', { device: 'reference@1.0', 'reference-value': MANIFEST });
const manifestDoc = { manifest: 'arweave/paths', version: '0.2.0', paths };

function gateway(opts: { namespaceInit?: GqlNode; manifest: object; ownerInits?: GqlNode[] }) {
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.includes('/raw/')) {
			return new Response(JSON.stringify(opts.manifest), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		const q = JSON.parse(String(init?.body)).query as string;
		let data: unknown;
		if (q.includes('transaction(id:')) data = { transaction: opts.namespaceInit ?? null };
		else if (q.includes('"reference-id"')) data = { transactions: { pageInfo: { hasNextPage: false }, edges: [] } };
		else data = { transactions: { pageInfo: { hasNextPage: false }, edges: (opts.ownerInits ?? []).map((n, i) => ({ cursor: `o${i}`, node: n })) } };
		return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return fetchImpl;
}

describe('ReferenceClient directory ops', () => {
	const client = () => new ReferenceClient({ fetch: gateway({ namespaceInit, manifest: manifestDoc, ownerInits: [node('R_owned', 'gj49', { device: 'reference@1.0' })] }), namespace: NS });

	it('lists names resolved through the namespace manifest', async () => {
		expect((await client().list()).entries.map((e) => e.name)).toEqual(['alice', 'alice-app', 'bob']);
	});

	it('looks up and resolves a name to its entry id', async () => {
		const c = client();
		expect(await c.lookup('alice')).toEqual({ name: 'alice', id: 'T_alice' });
		expect(await c.resolve('alice')).toBe('T_alice');
		expect(await c.resolve('missing')).toBeNull();
	});

	it('finds names owned by an address (per-name-reference entries)', async () => {
		expect(await client().namesByOwner('gj49')).toEqual([{ name: 'alice-app', id: 'R_owned' }]);
	});

	it('requires a configured namespace', async () => {
		const c = new ReferenceClient({ fetch: gateway({ namespaceInit, manifest: manifestDoc }) });
		await expect(c.list()).rejects.toThrow(/namespace/i);
	});
});

import { afterEach, describe, it, expect, vi } from 'vitest';
import { ReferenceClient } from '../src/client';
import type { SendOptions } from '../src/signer';
import type { Signer } from '../src/signer';
import type { Tag } from '../src/types';

afterEach(() => {
	vi.restoreAllMocks();
});

function stub(address = 'ME') {
	const sends: { tags: Tag[]; data?: string }[] = [];
	const opts: (SendOptions | undefined)[] = [];
	let n = 0;
	const signer: Signer = {
		async address() {
			return address;
		},
		async send(m, sendOpts) {
			sends.push(m);
			opts.push(sendOpts);
			return { id: `id-${++n}` };
		},
	};
	return { signer, sends, opts };
}

const noFetch = (async () => new Response('{}')) as unknown as typeof fetch;
const tagMap = (tags: Tag[]) => Object.fromEntries(tags.map((t) => [t.name, t.value]));

const gqlFetch = (init: { id: string; owner: string; tags: Record<string, string> }, sets: { id: string; owner: string; tags: Record<string, string>; block: number }[] = []) =>
	(async (_url: string, req?: RequestInit) => {
		const q = JSON.parse(String(req?.body)).query as string;
		const tags = (record: Record<string, string>) => Object.entries(record).map(([name, value]) => ({ name, value }));
		const data = q.includes('transaction(id:')
			? {
					transaction: {
						id: init.id,
						owner: { address: init.owner },
						tags: tags(init.tags),
						block: { height: 1 },
					},
				}
			: {
					transactions: {
						pageInfo: { hasNextPage: false },
						edges: sets.map((set, i) => ({
							cursor: `c${i}`,
							node: {
								id: set.id,
								owner: { address: set.owner },
								tags: tags(set.tags),
								block: { height: set.block },
							},
						})),
					},
				};
		return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;

describe('createReference (init)', () => {
	it('mints an init with no reference-id; the data-item id is the reference id', async () => {
		const s = stub();
		const client = new ReferenceClient({ fetch: noFetch, signer: s.signer });
		const { referenceId } = await client.createReference({ value: 'TARGET' });
		expect(referenceId).toBe('id-1');
		const m = tagMap(s.sends[0]!.tags);
		expect(m.device).toBe('reference@1.0');
		expect(m.authority).toBe('ME');
		expect(m['reference-value']).toBe('TARGET');
		expect(m['reference-id']).toBeUndefined();
		expect(m.timestamp).toBeDefined();
	});

	it('uses an explicit authority when provided', async () => {
		const s = stub();
		const client = new ReferenceClient({ fetch: noFetch, signer: s.signer });
		await client.createReference({ authority: 'AUTH', value: 'TARGET' });
		expect(tagMap(s.sends[0]!.tags).authority).toBe('AUTH');
	});

	it('passes the configured bundler to the signer', async () => {
		const s = stub();
		const client = new ReferenceClient({ fetch: noFetch, signer: s.signer, bundler: 'https://hb.example/~bundler@1.0/tx' });
		await client.createReference({ value: 'TARGET' });
		expect(s.opts[0]?.bundler).toBe('https://hb.example/~bundler@1.0/tx');
	});
});

describe('updateReference', () => {
	it('builds a set carrying the reference-id and the new value', async () => {
		const s = stub();
		const client = new ReferenceClient({
			fetch: gqlFetch({ id: 'R', owner: 'ME', tags: { device: 'reference@1.0', authority: 'ME', timestamp: '1', 'reference-value': 'OLD' } }),
			signer: s.signer,
		});
		expect((await client.updateReference('R', { value: 'NEW', timestamp: 10 })).id).toBe('id-1');
		const m = tagMap(s.sends[0]!.tags);
		expect(m.device).toBeUndefined();
		expect(m['reference-id']).toBe('R');
		expect(m['reference-value']).toBe('NEW');
		expect(m.timestamp).toBe('10');
	});

	it('defaults timestamp to max(Date.now(), latest timestamp + 1)', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(150);
		const s = stub();
		const client = new ReferenceClient({
			fetch: gqlFetch(
				{ id: 'R', owner: 'ME', tags: { device: 'reference@1.0', authority: 'ME', timestamp: '1', 'reference-value': 'OLD' } },
				[
					{
						id: 'S1',
						owner: 'ME',
						tags: { device: 'reference@1.0', 'reference-id': 'R', timestamp: '200', 'reference-value': 'LATEST' },
						block: 2,
					},
				],
			),
			signer: s.signer,
		});

		await client.updateReference('R', { value: 'NEW' });
		expect(tagMap(s.sends[0]!.tags).timestamp).toBe('201');
	});

	it('refuses to post when the signer is not the reference authority', async () => {
		const s = stub('WRONG');
		const client = new ReferenceClient({
			fetch: gqlFetch({ id: 'R', owner: 'ME', tags: { device: 'reference@1.0', authority: 'ME', timestamp: '1', 'reference-value': 'OLD' } }),
			signer: s.signer,
		});

		await expect(client.updateReference('R', { value: 'NEW', timestamp: 10 })).rejects.toThrow(/not reference authority/);
		expect(s.sends).toEqual([]);
	});
});

describe('write guards', () => {
	it('throws without a signer', async () => {
		const client = new ReferenceClient({ fetch: noFetch });
		await expect(client.createReference({ value: 'X' })).rejects.toThrow(/signer/i);
	});
});

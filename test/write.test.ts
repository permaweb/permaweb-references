import { describe, it, expect } from 'vitest';
import { ReferenceClient } from '../src/client';
import type { Signer } from '../src/signer';
import type { Tag } from '../src/types';

function stub() {
	const sends: { tags: Tag[]; data?: string }[] = [];
	let n = 0;
	const signer: Signer = {
		async address() {
			return 'ME';
		},
		async send(m) {
			sends.push(m);
			return { id: `id-${++n}` };
		},
	};
	return { signer, sends };
}

const noFetch = (async () => new Response('{}')) as unknown as typeof fetch;
const tagMap = (tags: Tag[]) => Object.fromEntries(tags.map((t) => [t.name, t.value]));

describe('createReference (init, §3)', () => {
	it('mints an init with no reference-id; the data-item id is the reference id', async () => {
		const s = stub();
		const client = new ReferenceClient({ fetch: noFetch, signer: s.signer });
		const { referenceId } = await client.createReference({ value: 'TARGET' });
		expect(referenceId).toBe('id-1');
		const m = tagMap(s.sends[0]!.tags);
		expect(m.device).toBe('reference@1.0');
		expect(m['reference-value']).toBe('TARGET');
		expect(m['reference-id']).toBeUndefined();
		expect(m.timestamp).toBeDefined();
	});
});

describe('setReference (set, §3/§4)', () => {
	it('builds a set carrying the reference-id and new value', async () => {
		const s = stub();
		const client = new ReferenceClient({ fetch: noFetch, signer: s.signer });
		expect((await client.setReference('R', { value: 'NEW' })).id).toBe('id-1');
		const m = tagMap(s.sends[0]!.tags);
		expect(m.device).toBe('reference@1.0');
		expect(m['reference-id']).toBe('R');
		expect(m['reference-value']).toBe('NEW');
	});
});

describe('registerName (§9)', () => {
	it('mints a downstream reference and returns its pointer', async () => {
		const s = stub();
		const client = new ReferenceClient({ fetch: noFetch, signer: s.signer });
		const r = await client.registerName('alice', { value: 'TARGET' });
		expect(r).toEqual({ name: 'alice', referenceId: 'id-1', pointer: { device: 'reference@1.0', 'reference-id': 'id-1' } });
	});
});

describe('updateDirectory (operator, §9)', () => {
	it('uploads a manifest then points the namespace reference at it', async () => {
		const s = stub();
		const client = new ReferenceClient({ fetch: noFetch, signer: s.signer, namespace: 'NS' });
		const { manifestId, setId } = await client.updateDirectory({ alice: { id: 'T_a' } });
		expect(manifestId).toBe('id-1');
		expect(setId).toBe('id-2');
		const manifestTags = tagMap(s.sends[0]!.tags);
		expect(manifestTags.device).toBe('manifest@1.0');
		expect(manifestTags['content-type']).toContain('arweave-manifest');
		expect(JSON.parse(s.sends[0]!.data!).paths).toEqual({ alice: { id: 'T_a' } });
		const setTags = tagMap(s.sends[1]!.tags);
		expect(setTags['reference-id']).toBe('NS');
		expect(setTags['reference-value']).toBe('id-1');
	});
});

describe('write guards', () => {
	it('throws without a signer', async () => {
		const client = new ReferenceClient({ fetch: noFetch });
		await expect(client.createReference({ value: 'X' })).rejects.toThrow(/signer/i);
	});
});

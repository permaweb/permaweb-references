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

describe('createReference (init)', () => {
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

describe('updateReference', () => {
	it('builds a set carrying the reference-id and the new value', async () => {
		const s = stub();
		const client = new ReferenceClient({ fetch: noFetch, signer: s.signer });
		expect((await client.updateReference('R', { value: 'NEW' })).id).toBe('id-1');
		const m = tagMap(s.sends[0]!.tags);
		expect(m.device).toBe('reference@1.0');
		expect(m['reference-id']).toBe('R');
		expect(m['reference-value']).toBe('NEW');
	});
});

describe('write guards', () => {
	it('throws without a signer', async () => {
		const client = new ReferenceClient({ fetch: noFetch });
		await expect(client.createReference({ value: 'X' })).rejects.toThrow(/signer/i);
	});
});

import { afterEach, describe, it, expect, vi } from 'vitest';
import { ReferenceClient } from '../src/client';
import type { SendOptions, SendTransactionOptions, TransactionMessage } from '../src/signer';
import type { Signer } from '../src/signer';
import type { Tag } from '../src/types';
import type { SwapOrder } from '../src/names';

afterEach(() => {
	vi.restoreAllMocks();
});

function stub(address = 'ME') {
	const sends: { tags: Tag[]; data?: string }[] = [];
	const opts: (SendOptions | undefined)[] = [];
	const txs: TransactionMessage[] = [];
	const txOpts: (SendTransactionOptions | undefined)[] = [];
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
		async sendTransaction(m, sendOpts) {
			txs.push(m);
			txOpts.push(sendOpts);
			return { id: `id-${++n}` };
		},
	};
	return { signer, sends, opts, txs, txOpts };
}

const noFetch = (async () => new Response('{}')) as unknown as typeof fetch;
const tagMap = (tags: Tag[]) => Object.fromEntries(tags.map((t) => [t.name, t.value]));
const PROCESS = 'p'.repeat(43);
const TARGET = 't'.repeat(43);
const HOLDER = 'h'.repeat(43);
const BUYER = 'b'.repeat(43);
const SELLER = 's'.repeat(43);
const RECIPIENT = 'r'.repeat(43);
const ORDER = 'o'.repeat(43);

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

function carrierOrder(overrides: Partial<SwapOrder> = {}): SwapOrder {
	return {
		orderId: ORDER,
		creator: SELLER,
		recipient: SELLER,
		quantity: 1,
		asking: '100',
		deposit: '0',
		minimumFee: '9',
		deadline: 200,
		createdAt: 90,
		status: 'open',
		...overrides,
	};
}

function rawCarrierOrder(order: SwapOrder): Record<string, unknown> {
	return {
		'order-id': order.orderId,
		creator: order.creator,
		recipient: order.recipient,
		quantity: String(order.quantity),
		asking: order.asking,
		deposit: order.deposit,
		'minimum-fee': order.minimumFee,
		deadline: String(order.deadline),
		'created-at': String(order.createdAt),
		status: order.status,
		...(order.buyer ? { buyer: order.buyer } : {}),
		...(order.reservedUntil === undefined ? {} : { 'reserved-until': String(order.reservedUntil) }),
		...(order.paymentTx ? { 'payment-tx': order.paymentTx } : {}),
	};
}

function carrierState(overrides: Record<string, unknown> = {}) {
	return {
		device: 'process@1.0',
		'execution-device': 'carrier@1.0',
		name: 'pn-test',
		'total-supply': '1',
		balances: { [HOLDER]: '1' },
		value: { target: TARGET },
		orders: {},
		'swap-height': '100',
		...overrides,
	};
}

function carrierFetch(states: unknown[], opts: { balance?: string; price?: string; height?: number } = {}) {
	let reads = 0;
	return (async (url: string) => {
		const held = String(url);
		if (held.includes('~process@1.0/')) {
			const state = states[Math.min(reads, states.length - 1)];
			reads += 1;
			return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (held.endsWith('/info')) {
			return new Response(JSON.stringify({ height: opts.height ?? 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (held.includes('/price/0/')) return new Response(opts.price ?? '5', { status: 200 });
		if (held.includes('/wallet/')) return new Response(opts.balance ?? '1000000', { status: 200 });
		return new Response('{}', { status: 200 });
	}) as unknown as typeof fetch;
}

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

describe('carrier process writes', () => {
	it('sets a carrier target through a data-free process transaction after live holder and balance checks', async () => {
		const s = stub(HOLDER);
		const client = new ReferenceClient({
			gateway: 'https://gw.test',
			node: 'https://node.test',
			fetch: carrierFetch([carrierState()]),
			signer: s.signer,
		});

		await expect(client.setCarrierTarget(PROCESS, TARGET)).resolves.toEqual({ id: 'id-1' });
		expect(s.txs).toHaveLength(1);
		expect(s.txs[0]).toMatchObject({ target: PROCESS, quantity: '1' });
		expect(tagMap(s.txs[0]!.tags)).toEqual({ action: 'set', 'reference-value': TARGET });
		expect(s.txOpts[0]).toMatchObject({ gateway: 'https://gw.test', expectedSigner: HOLDER });
	});

	it('transfers a carrier only to a valid Arweave recipient address', async () => {
		const s = stub(HOLDER);
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState(), carrierState()]),
			signer: s.signer,
		});

		await expect(client.transferCarrier(PROCESS, 'not-an-address')).rejects.toThrow(/invalid-carrier-recipient/);
		expect(s.txs).toEqual([]);

		await expect(client.transferCarrier(PROCESS, RECIPIENT)).resolves.toEqual({ id: 'id-1' });
		expect(s.txs[0]).toMatchObject({ target: PROCESS, quantity: '1' });
		expect(tagMap(s.txs[0]!.tags)).toEqual({ action: 'transfer', recipient: RECIPIENT, quantity: '1' });
	});

	it('refuses carrier writes when the signer cannot make process transactions', async () => {
		const { signer } = stub(HOLDER);
		const noProcessSigner: Signer = {
			address: signer.address,
			send: signer.send,
		};
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState()]),
			signer: noProcessSigner,
		});

		await expect(client.setCarrierTarget(PROCESS, TARGET)).rejects.toThrow(/process transactions/);
	});

	it('refuses to sign when live carrier state says the signer is not the holder', async () => {
		const s = stub(HOLDER);
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState({ balances: { [RECIPIENT]: '1' } })]),
			signer: s.signer,
		});

		await expect(client.setCarrierTarget(PROCESS, TARGET)).rejects.toThrow(/not carrier holder/);
		expect(s.txs).toEqual([]);
	});

	it('makes an offer only from live holder state and a valid current height', async () => {
		const s = stub(HOLDER);
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState()], { height: 120 }),
			signer: s.signer,
		});

		await expect(client.makeCarrierOffer(PROCESS, { asking: '1000' })).resolves.toEqual({ id: 'id-1' });
		expect(s.txs[0]).toMatchObject({ target: PROCESS, quantity: '1' });
		expect(tagMap(s.txs[0]!.tags)).toMatchObject({
			action: 'make-offer',
			'offer-quantity': '1',
			asking: '1000',
			deposit: '0',
			'minimum-fee': '100000000',
			deadline: String(120 + 21600),
		});
	});

	it('fails closed when gateway height lookup is malformed', async () => {
		const s = stub(HOLDER);
		const fetcher = (async (url: string) => {
			const held = String(url);
			if (held.includes('~process@1.0/')) return new Response(JSON.stringify(carrierState()), { status: 200 });
			if (held.endsWith('/info')) return new Response(JSON.stringify({ height: 'bad' }), { status: 200 });
			return new Response('5', { status: 200 });
		}) as unknown as typeof fetch;
		const client = new ReferenceClient({ fetch: fetcher, signer: s.signer });

		await expect(client.makeCarrierOffer(PROCESS, { asking: '1000' })).rejects.toThrow(/valid height/);
		expect(s.txs).toEqual([]);
	});

	it('cancels only an open live order created by the signer', async () => {
		const order = carrierOrder({ creator: HOLDER, recipient: HOLDER });
		const s = stub(HOLDER);
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState({ balances: { [HOLDER]: '0' }, orders: { [ORDER]: rawCarrierOrder(order) } })]),
			signer: s.signer,
		});

		await expect(client.cancelCarrierOrder(PROCESS, ORDER)).resolves.toEqual({ id: 'id-1' });
		expect(tagMap(s.txs[0]!.tags)).toEqual({ action: 'cancel-order', 'order-id': ORDER });
	});

	it('does not pay until the live order is reserved for the signer', async () => {
		const openOrder = carrierOrder({ status: 'open' });
		const s = stub(BUYER);
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState({ balances: { [SELLER]: '0', [BUYER]: '0' }, orders: { [ORDER]: rawCarrierOrder(openOrder) } })]),
			signer: s.signer,
		});

		await expect(client.payCarrierOrder(PROCESS, openOrder, { currentHeight: 100 })).rejects.toThrow(/not purchasable/);
		expect(s.txs).toEqual([]);
	});

	it('rejects payment when reserved-until does not cover current height plus buffer', async () => {
		const reserved = carrierOrder({ status: 'reserved', buyer: BUYER, reservedUntil: 101 });
		const s = stub(BUYER);
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState({ balances: { [SELLER]: '0', [BUYER]: '0' }, orders: { [ORDER]: rawCarrierOrder(reserved) } })]),
			signer: s.signer,
		});

		await expect(client.payCarrierOrder(PROCESS, reserved, { currentHeight: 100, inclusionMargin: 2 })).rejects.toThrow(/not purchasable/);
		expect(s.txs).toEqual([]);
	});

	it('pays a reserved order for the signer after checking buyer balance covers amount plus L1 fee', async () => {
		const reserved = carrierOrder({ status: 'reserved', buyer: BUYER, reservedUntil: 150 });
		const s = stub(BUYER);
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState({ balances: { [SELLER]: '0', [BUYER]: '0' }, orders: { [ORDER]: rawCarrierOrder(reserved) } })], {
				price: '7',
				balance: '107',
			}),
			signer: s.signer,
		});

		await expect(client.payCarrierOrder(PROCESS, reserved, { currentHeight: 100, inclusionMargin: 2 })).resolves.toEqual({ id: 'id-1' });
		expect(s.txs[0]).toMatchObject({ target: SELLER, quantity: '100' });
		expect(tagMap(s.txs[0]!.tags)).toEqual({ 'order-id': ORDER });
	});

	it('refuses to sign swap transactions when wallet balance cannot cover payment and L1 fees', async () => {
		const reserved = carrierOrder({ status: 'reserved', buyer: BUYER, reservedUntil: 150 });
		const s = stub(BUYER);
		const client = new ReferenceClient({
			fetch: carrierFetch([carrierState({ balances: { [SELLER]: '0', [BUYER]: '0' }, orders: { [ORDER]: rawCarrierOrder(reserved) } })], {
				price: '7',
				balance: '106',
			}),
			signer: s.signer,
		});

		await expect(client.payCarrierOrder(PROCESS, reserved, { currentHeight: 100, inclusionMargin: 2 })).rejects.toThrow(/insufficient wallet balance/);
		expect(s.txs).toEqual([]);
	});

	it('registers an open order, waits for live reservation, then pays', async () => {
		const open = carrierOrder({ status: 'open' });
		const reserved = carrierOrder({ status: 'reserved', buyer: BUYER, reservedUntil: 150 });
		const s = stub(BUYER);
		const client = new ReferenceClient({
			fetch: carrierFetch(
				[
					carrierState({ balances: { [SELLER]: '0', [BUYER]: '0' }, orders: { [ORDER]: rawCarrierOrder(open) } }),
					carrierState({ balances: { [SELLER]: '0', [BUYER]: '0' }, orders: { [ORDER]: rawCarrierOrder(reserved) } }),
					carrierState({ balances: { [SELLER]: '0', [BUYER]: '0' }, orders: { [ORDER]: rawCarrierOrder(reserved) } }),
				],
				{ price: '5', balance: '1000', height: 100 }
			),
			signer: s.signer,
		});

		await expect(client.buyCarrierOrder(PROCESS, open, { currentHeight: 100, reservationInterval: 0 })).resolves.toEqual({
			registrationId: 'id-1',
			paymentId: 'id-2',
		});
		expect(s.txs).toHaveLength(2);
		expect(tagMap(s.txs[0]!.tags)).toEqual({ action: 'register-interest', 'order-id': ORDER });
		expect(s.txs[0]).toMatchObject({ target: PROCESS, quantity: '0', rewardFloor: '9' });
		expect(tagMap(s.txs[1]!.tags)).toEqual({ 'order-id': ORDER });
		expect(s.txs[1]).toMatchObject({ target: SELLER, quantity: '100' });
	});
});

describe('write guards', () => {
	it('throws without a signer', async () => {
		const client = new ReferenceClient({ fetch: noFetch });
		await expect(client.createReference({ value: 'X' })).rejects.toThrow(/signer/i);
	});
});

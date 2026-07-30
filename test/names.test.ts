import { describe, expect, it, vi } from 'vitest';

import {
	findNamesNamespaceEntries,
	findOwnedNamesCarriers,
	findPurchasedNamesCarriers,
	carrierTarget,
	isLiveOfferCandidate,
	listMarketplaceListings,
	ownerOfCarrier,
	parseNamesNamespace,
	parseCarrierState,
	readCarrierState,
	resolveNamesNamespace,
	resolveNamesNamespaceReference,
	streamMarketplaceListings,
} from '../src/names';

const PROCESS = 'p'.repeat(43);
const PROCESS_TWO = 'q'.repeat(43);
const REFERENCE = 'r'.repeat(43);
const REFERENCE_TWO = 's'.repeat(43);
const LEGACY_REFERENCE = 'l'.repeat(43);
const HOLDER = 'h'.repeat(43);
const BUYER = 'b'.repeat(43);
const ORDER = 'o'.repeat(43);
const ORDER_TWO = 'u'.repeat(43);

function manifest(paths: Record<string, { id: string }>): string {
	return JSON.stringify({ manifest: 'arweave/paths', version: '0.2.0', paths });
}

function state(overrides: Record<string, unknown> = {}) {
	return {
		device: 'process@1.0',
		'execution-device': 'carrier@1.0',
		name: 'pn-test',
		'total-supply': '1',
		balances: { [HOLDER]: '1' },
		value: { target: REFERENCE },
		orders: {
			[ORDER]: {
				'order-id': ORDER,
				creator: HOLDER,
				recipient: HOLDER,
				quantity: '1',
				asking: '100',
				deposit: '0',
				'minimum-fee': '1',
				deadline: '200',
				'created-at': '100',
				status: 'open',
			},
		},
		...overrides,
	};
}

function offerNode(id: string, processId: string, overrides: Record<string, string> = {}) {
	const tags = {
		action: 'make-offer',
		'offer-quantity': '1',
		asking: '100',
		'minimum-fee': '1',
		deadline: '200',
		...overrides,
	};
	return {
		cursor: id,
		node: {
			id,
			recipient: processId,
			owner: { address: HOLDER },
			block: { height: 120, timestamp: 1700000000 },
			tags: Object.entries(tags).map(([name, value]) => ({ name, value })),
		},
	};
}

describe('mainnet names namespace helpers', () => {
	it('parses the namespace without resolving process headers', () => {
		const namespace = parseNamesNamespace(manifest({ alpha: { id: PROCESS }, legacy: { id: LEGACY_REFERENCE } }));

		expect(namespace.names).toEqual({ alpha: PROCESS, legacy: LEGACY_REFERENCE });
		expect(namespace.byReference).toEqual({ [PROCESS]: 'alpha', [LEGACY_REFERENCE]: 'legacy' });
	});

	it('keeps direct reference entries separate from carrier process entries', () => {
		const namespace = parseNamesNamespace(manifest({ alpha: { id: PROCESS }, legacy: { id: LEGACY_REFERENCE } }));

		expect(findNamesNamespaceEntries(namespace, [REFERENCE, LEGACY_REFERENCE])).toEqual([
			{ name: 'legacy', namespaceId: LEGACY_REFERENCE, referenceId: LEGACY_REFERENCE },
		]);
	});

	it('resolves carrier initial-value headers while preserving namespace ids', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const id = String(input).split('/').at(-1);
			return new Response(null, {
				status: 200,
				headers: {
					'execution-device': 'carrier@1.0',
					'initial-value': id === PROCESS ? REFERENCE : REFERENCE_TWO,
				},
			});
		});

		const namespace = await resolveNamesNamespace(
			manifest({ alpha: { id: PROCESS }, beta: { id: PROCESS_TWO } }),
			{ gateway: 'https://arweave.net/', fetch: fetcher }
		);

		expect(namespace.names).toEqual({ alpha: PROCESS, beta: PROCESS_TWO });
		expect(namespace.references).toEqual({ alpha: REFERENCE, beta: REFERENCE_TWO });
		expect(namespace.byReferenceId).toEqual({ [REFERENCE]: 'alpha', [REFERENCE_TWO]: 'beta' });
	});

	it('keeps legacy namespace ids when a header is not a names process', async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 200, headers: { device: 'reference@1.0' } }));

		await expect(
			resolveNamesNamespaceReference(LEGACY_REFERENCE, { gateway: 'https://arweave.net', fetch: fetcher })
		).resolves.toBe(LEGACY_REFERENCE);
	});

	it('finds holder carriers and purchased carriers through GraphQL', async () => {
		const namespace = parseNamesNamespace(manifest({ alpha: { id: PROCESS }, beta: { id: PROCESS_TWO } }));
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			const tags = body.variables.tags as Array<{ name: string; values: string[] }>;
			if (body.variables.owners) {
				expect(body.variables.owners).toEqual([BUYER]);
				return Response.json({
					data: {
						transactions: {
							pageInfo: { hasNextPage: false },
							edges: [
								{
									cursor: 'purchase',
									node: {
										id: 'x'.repeat(43),
										recipient: PROCESS_TWO,
										owner: { address: BUYER },
										tags: [
											{ name: 'action', value: 'register-interest' },
											{ name: 'order-id', value: ORDER },
										],
									},
								},
							],
						},
					},
				});
			}

			expect(tags[0]).toMatchObject({ values: ['carrier@1.0'] });
			return Response.json({
				data: {
					transactions: {
						pageInfo: { hasNextPage: false },
						edges: [
							{
								cursor: 'owned',
								node: {
									id: PROCESS,
									owner: { address: HOLDER },
									tags: [
										{ name: tags[0]!.name, value: 'carrier@1.0' },
										{ name: 'initial-holder', value: HOLDER },
										{ name: 'initial-value', value: REFERENCE },
									],
								},
							},
						],
					},
				},
			});
		});

		await expect(findOwnedNamesCarriers(namespace, HOLDER, { graphql: 'https://gql.test', fetch: fetcher })).resolves.toEqual([
			{ name: 'alpha', processId: PROCESS, initialHolder: HOLDER, initialValue: REFERENCE },
		]);
		await expect(findPurchasedNamesCarriers(namespace, BUYER, { graphql: 'https://gql.test', fetch: fetcher })).resolves.toEqual([
			{ name: 'beta', processId: PROCESS_TWO },
		]);
	});
});

describe('carrier state parsing', () => {
	it('parses current carrier state and extracts owner/target', () => {
		const parsed = parseCarrierState({ body: JSON.stringify(state()) });

		expect(parsed.device).toBe('carrier@1.0');
		expect(ownerOfCarrier(parsed)).toBe(HOLDER);
		expect(carrierTarget(parsed.value)).toBe(REFERENCE);
	});
});

describe('carrier marketplace listings', () => {
	it('groups offer candidates by process and returns only live verified listings', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				return Response.json({
					data: {
						transactions: {
							pageInfo: { hasNextPage: false },
							edges: [
								offerNode(ORDER_TWO, PROCESS, { asking: '999' }),
								offerNode(ORDER, PROCESS),
								offerNode('x'.repeat(43), PROCESS_TWO),
								offerNode('z'.repeat(43), LEGACY_REFERENCE),
							],
						},
					},
				});
			}
			if (String(input).includes(`${PROCESS}~process@1.0`)) {
				return Response.json(state({ balances: { [HOLDER]: '0' } }));
			}
			if (String(input).includes(`${PROCESS_TWO}~process@1.0`)) {
				return Response.json(state({
					balances: { [HOLDER]: '0' },
					orders: {
						['x'.repeat(43)]: {
							'order-id': 'x'.repeat(43),
							creator: HOLDER,
							recipient: HOLDER,
							quantity: '1',
							asking: '101',
							deposit: '0',
							'minimum-fee': '1',
							deadline: '200',
							'created-at': '100',
							status: 'open',
						},
					},
				}));
			}
			throw new Error(`unexpected fetch: ${String(input)}`);
		});

		const listings = await listMarketplaceListings({ alpha: PROCESS, beta: PROCESS_TWO }, {
			graphql: 'https://gql.test',
			provider: 'https://node.test',
			fetch: fetcher,
			concurrency: 1,
		});

		expect(listings).toHaveLength(1);
		expect(listings[0]).toMatchObject({
			name: 'alpha',
			processId: PROCESS,
			status: 'ready',
			candidate: { id: ORDER, asking: '100', minimumFee: '1', deadline: 200 },
			order: { orderId: ORDER, asking: '100', minimumFee: '1', deadline: 200, status: 'open' },
			provider: 'https://node.test',
			path: 'now',
		});
		expect(listings[0]?.state?.balances[HOLDER]).toBe('0');
		expect(fetcher).toHaveBeenCalledWith(
			`https://node.test/${PROCESS}~process@1.0/now&max-age=60?require-codec=json%401.0&accept-bundle=true`,
			expect.any(Object)
		);
		expect(fetcher).not.toHaveBeenCalledWith(
			expect.stringContaining(`${LEGACY_REFERENCE}~process@1.0`),
			expect.any(Object)
		);
	});

	it('streams resolving and unavailable states without returning stale listings', async () => {
		const updates: Array<Array<{ processId: string; status: string; error?: string }>> = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				return Response.json({
					data: {
						transactions: {
							pageInfo: { hasNextPage: false },
							edges: [offerNode(ORDER, PROCESS)],
						},
					},
				});
			}
			if (String(input).includes(`${PROCESS}~process@1.0/now`)) {
				return new Response('timeout', { status: 504 });
			}
			if (String(input).includes(`${PROCESS}~process@1.0/compute`)) {
				return Response.json(state({ 'swap-height': '200' }));
			}
			throw new Error(`unexpected fetch: ${String(input)}`);
		});

		const listings = await streamMarketplaceListings({ alpha: PROCESS }, (next) => {
			updates.push(next.map((listing) => ({
				processId: listing.processId,
				status: listing.status,
				error: listing.error,
			})));
		}, {
			graphql: 'https://gql.test',
			provider: 'https://node.test',
			fetch: fetcher,
			concurrency: 1,
		});

		expect(listings).toEqual([]);
		expect(updates).toEqual([
			[{ processId: PROCESS, status: 'resolving', error: undefined }],
			[{ processId: PROCESS, status: 'unavailable', error: undefined }],
		]);
	});

	it('checks the full live order economics for candidate readiness', () => {
		const parsed = parseCarrierState(state({ balances: { [HOLDER]: '0' } }));
		expect(isLiveOfferCandidate(parsed, {
			id: ORDER,
			processId: PROCESS,
			creator: HOLDER,
			height: 120,
			timestamp: 1700000000,
			asking: '100',
			minimumFee: '1',
			deadline: 200,
		})).toBe(true);
		expect(isLiveOfferCandidate(parsed, {
			id: ORDER,
			processId: PROCESS,
			creator: HOLDER,
			height: 120,
			timestamp: 1700000000,
			asking: '101',
			minimumFee: '1',
			deadline: 200,
		})).toBe(false);
		expect(isLiveOfferCandidate(parseCarrierState(state()), {
			id: ORDER,
			processId: PROCESS,
			creator: HOLDER,
			height: 120,
			timestamp: 1700000000,
			asking: '100',
			minimumFee: '1',
			deadline: 200,
		})).toBe(false);
	});
});

describe('carrier state reads', () => {
	it('reads /now first by default', async () => {
		const urls: string[] = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return Response.json(state());
		});

		const result = await readCarrierState(PROCESS, { provider: 'https://node.test/', fetch: fetcher });

		expect(result.path).toBe('now');
		expect(urls[0]).toBe(
			`https://node.test/${PROCESS}~process@1.0/now&max-age=60?require-codec=json%401.0&accept-bundle=true`
		);
	});

	it('falls back to /compute when /now fails', async () => {
		const urls: string[] = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return urls.length === 1 ? new Response('timeout', { status: 504 }) : Response.json(state());
		});

		const result = await readCarrierState(PROCESS, { provider: 'https://node.test', fetch: fetcher });

		expect(result.path).toBe('compute');
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(urls[0]).toContain('/now&max-age=60');
		expect(urls[1]).toContain('/compute&max-age=60');
	});

	it('can force a single carrier read path', async () => {
		const urls: string[] = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return Response.json(state());
		});

		const result = await readCarrierState(PROCESS, {
			provider: 'https://node.test',
			fetch: fetcher,
			path: 'compute',
		});

		expect(result.path).toBe('compute');
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(urls[0]).toContain('/compute&max-age=60');
	});
});

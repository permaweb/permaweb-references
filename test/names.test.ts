import { describe, expect, it, vi } from 'vitest';

import {
	findNamesNamespaceEntries,
	findOwnedNamesCarriers,
	findPurchasedNamesCarriers,
	carrierTarget,
	ownerOfCarrier,
	parseNamesNamespace,
	parseCarrierState,
	resolveNamesNamespace,
	resolveNamesNamespaceReference,
} from '../src/names';

const PROCESS = 'p'.repeat(43);
const PROCESS_TWO = 'q'.repeat(43);
const REFERENCE = 'r'.repeat(43);
const REFERENCE_TWO = 's'.repeat(43);
const LEGACY_REFERENCE = 'l'.repeat(43);
const HOLDER = 'h'.repeat(43);
const BUYER = 'b'.repeat(43);
const ORDER = 'o'.repeat(43);

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

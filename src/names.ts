import type { Address, OwnedName } from './types.js';
import { parseNamespace, type Namespace } from './namespace.js';

const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;
const CARRIER_DEVICES = new Set(['carrier@1.0']);
const LIVE_ORDER = new Set<SwapOrderStatus>(['open', 'reserved']);
const GRAPHQL_PAGE_SIZE = 100;
const GRAPHQL_MAX_PAGES = 100;
const CARRIER_LOOKUP_CONCURRENCY = 8;
const COMPUTE_TIMEOUT = 12_000;

export type NamesNamespace = Namespace & {
	/** name -> reference id carried by a carrier process */
	references: Record<string, string>;
	/** reference id -> name */
	byReferenceId: Record<string, string>;
};

export type NamesNamespaceEntry = {
	name: string;
	namespaceId: string;
	referenceId: string;
};

export type NamesCarrierEntry = {
	name: string;
	processId: string;
	initialHolder: string;
	initialValue: string;
};

export type NamesCarrierCandidate = Pick<NamesCarrierEntry, 'name' | 'processId'>;

export type SwapOrderStatus = 'open' | 'reserved' | 'settled' | 'cancelled' | 'expired';

export type SwapOrder = {
	orderId: string;
	creator: string;
	recipient: string;
	asking: string;
	deposit: string;
	minimumFee: string;
	deadline: number;
	createdAt: number;
	quantity: number;
	status: SwapOrderStatus;
	buyer?: string;
	reservedUntil?: number;
	paymentTx?: string;
};

export type CarrierState = {
	device: string;
	name: string;
	totalSupply: number;
	balances: Record<string, string>;
	orders: Record<string, SwapOrder>;
	swapHeight: number;
	value: unknown;
	raw: Record<string, unknown>;
};

export type CarrierReadResult = {
	state: CarrierState;
	provider: string;
};

export type OfferCandidate = {
	id: string;
	processId: string;
	creator: string;
	height: number;
	timestamp: number;
	asking: string;
	minimumFee: string;
	deadline: number;
};

type GraphqlTag = { name: string; value: string };
type GraphqlNode = {
	id: string;
	recipient?: string;
	owner: { address: string };
	block?: { height: number; timestamp: number };
	tags: GraphqlTag[];
};

export function isArweaveId(value: string): boolean {
	return ARWEAVE_ID.test(value);
}

/** Parse a namespace manifest without resolving carrier entries. */
export function parseNamesNamespace(text: string): Namespace {
	return parseNamespace(text);
}

/** Find traditional reference entries that are directly present in the namespace. */
export function findNamesNamespaceEntries(namespace: Namespace, referenceIds: string[]): NamesNamespaceEntry[] {
	const references = [...new Set(referenceIds.filter(isArweaveId))];
	return references.flatMap((referenceId) => {
		const name = namespace.byReference[referenceId];
		return name ? [{ name, namespaceId: referenceId, referenceId }] : [];
	});
}

/**
 * Resolve every carrier namespace entry to the reference id it was
 * seeded with. `names` and `byReference` still point at namespace process ids.
 */
export async function resolveNamesNamespace(
	text: string,
	options: {
		gateway: string;
		fetch: typeof fetch;
	}
): Promise<NamesNamespace> {
	const namespace = parseNamesNamespace(text);
	const references: Record<string, string> = {};
	const byReferenceId: Record<string, string> = {};
	const gateway = options.gateway.replace(/\/+$/, '');
	const entries = Object.entries(namespace.names);
	let cursor = 0;

	const workers = Array.from({ length: Math.min(CARRIER_LOOKUP_CONCURRENCY, entries.length) }, async () => {
		while (cursor < entries.length) {
			const index = cursor;
			cursor += 1;
			const [name, namespaceId] = entries[index]!;
			const referenceId = await resolveNamesNamespaceReference(namespaceId, { gateway, fetch: options.fetch });
			references[name] = referenceId;
			byReferenceId[referenceId] = name;
		}
	});
	await Promise.all(workers);

	return { ...namespace, references, byReferenceId };
}

export async function resolveNamesNamespaceReference(
	namespaceId: string,
	options: {
		gateway: string;
		fetch: typeof fetch;
	}
): Promise<string> {
	const gateway = options.gateway.replace(/\/+$/, '');
	const response = await options.fetch(`${gateway}/${namespaceId}`, { method: 'HEAD' });
	if (!response.ok) throw new Error(`namespace entry fetch failed: ${response.status} for ${namespaceId}`);

	const device = (response.headers.get('execution-device') ?? response.headers.get('device') ?? '').trim().toLowerCase();
	const initialValue = response.headers.get('initial-value')?.trim();
	const isCarrier = Boolean(initialValue || CARRIER_DEVICES.has(device));
	const referenceId = initialValue || (isCarrier ? response.headers.get('reference-id')?.trim() : undefined);

	if (!isCarrier) return namespaceId;
	if (!referenceId || !isArweaveId(referenceId)) {
		throw new Error(`namespace carrier does not contain a valid reference id: ${namespaceId}`);
	}
	return referenceId;
}

export async function isCarrierProcess(
	id: string,
	options: { graphql: string; fetch: typeof fetch; signal?: AbortSignal }
): Promise<boolean> {
	if (!isArweaveId(id)) return false;
	const payload = await gqlJson(options.graphql, {
		query: `query CarrierProcess($id: ID!) {
			transaction(id: $id) { id tags { name value } }
		}`,
		variables: { id },
		fetch: options.fetch,
		signal: options.signal,
		errorPrefix: 'carrier-process-graphql',
	});
	const tags = tagRecord(payload?.data?.transaction?.tags);
	const device = tags['execution-device'] ?? tags.device;
	return Boolean(device && CARRIER_DEVICES.has(device));
}

export async function readCarrierState(
	processId: string,
	options: {
		provider: string;
		fetch: typeof fetch;
		signal?: AbortSignal;
	}
): Promise<CarrierReadResult> {
	if (!isArweaveId(processId)) throw new TypeError('invalid-carrier-process-id');
	const provider = options.provider.replace(/\/+$/, '');
	const paths = [
		`${provider}/${processId}~process@1.0/now&max-age=60?require-codec=json%401.0&accept-bundle=true`,
		`${provider}/${processId}~process@1.0/now?require-codec=application%2Fjson&accept-bundle=true`,
	];
	let lastError: unknown;

	for (const path of paths) {
		const request = timeoutSignal(options.signal, COMPUTE_TIMEOUT);
		try {
			const response = await options.fetch(path, {
				headers: {
					accept: 'application/json',
					'require-codec': 'application/json',
					'accept-bundle': 'true',
				},
				signal: request.signal,
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return { state: parseCarrierState(await response.json()), provider };
		} catch (error) {
			lastError = error;
		} finally {
			request.cleanup();
		}
	}

	throw lastError instanceof Error ? lastError : new Error('compute-provider-failed');
}

export async function waitForCarrierState(
	processId: string,
	accept: (state: CarrierState) => boolean | Promise<boolean>,
	options: {
		provider: string;
		fetch: typeof fetch;
		signal?: AbortSignal;
		interval?: number;
		timeout?: number;
	}
): Promise<CarrierReadResult> {
	const startedAt = Date.now();
	const timeout = options.timeout ?? 180_000;

	while (Date.now() - startedAt < timeout) {
		if (options.signal?.aborted) throw options.signal.reason;
		try {
			const result = await readCarrierState(processId, options);
			if (await accept(result.state)) return result;
		} catch (error) {
			if (options.signal?.aborted) throw error;
		}
		await delay(options.interval ?? 4000, options.signal);
	}

	throw new Error('carrier-state-timeout');
}

export function parseCarrierState(value: unknown): CarrierState {
	const raw = unwrapState(value);
	const device = text(raw['execution-device'] ?? raw.device);
	const totalSupply = integer(raw['total-supply']);
	const balances = stringRecord(raw.balances);
	if (!CARRIER_DEVICES.has(device) || totalSupply !== 1 || !balances) {
		throw new TypeError('invalid-carrier-state');
	}

	const orders: Record<string, SwapOrder> = {};
	if (isRecord(raw.orders)) {
		for (const [id, held] of Object.entries(raw.orders)) {
			const order = parseSwapOrder(id, held);
			if (order) orders[id] = order;
		}
	}

	return {
		device,
		name: text(raw.name),
		totalSupply,
		balances,
		orders,
		swapHeight: integer(raw['swap-height']) ?? 0,
		value: raw.value ?? raw['initial-value'],
		raw,
	};
}

export function parseSwapOrder(id: string, value: unknown): SwapOrder | null {
	if (!isArweaveId(id) || !isRecord(value)) return null;
	const orderId = text(value['order-id']);
	const creator = text(value.creator);
	const recipient = text(value.recipient);
	const asking = amount(value.asking);
	const deposit = amount(value.deposit) ?? '0';
	const minimumFee = amount(value['minimum-fee']) ?? '0';
	const deadline = integer(value.deadline);
	const createdAt = integer(value['created-at']) ?? 0;
	const quantity = integer(value.quantity);
	const status = text(value.status) as SwapOrderStatus;

	if (
		orderId !== id ||
		!isArweaveId(creator) ||
		!isArweaveId(recipient) ||
		asking === null ||
		BigInt(asking) < 1n ||
		deadline === null ||
		quantity === null ||
		!['open', 'reserved', 'settled', 'cancelled', 'expired'].includes(status)
	) {
		return null;
	}

	const buyer = text(value.buyer);
	const reservedUntil = integer(value['reserved-until']);
	const paymentTx = text(value['payment-tx']);

	return {
		orderId,
		creator,
		recipient,
		asking,
		deposit,
		minimumFee,
		deadline,
		createdAt,
		quantity,
		status,
		...(isArweaveId(buyer) ? { buyer } : {}),
		...(reservedUntil === null ? {} : { reservedUntil }),
		...(isArweaveId(paymentTx) ? { paymentTx } : {}),
	};
}

export function ownerOfCarrier(state: CarrierState): string | null {
	const holder = Object.entries(state.balances).find(([, balance]) => balance === '1');
	if (holder && isArweaveId(holder[0])) return holder[0];
	const escrowed = Object.values(state.orders).find((order) => LIVE_ORDER.has(order.status) && order.quantity === 1);
	return escrowed?.creator ?? null;
}

export function carrierTarget(value: unknown): string {
	if (typeof value === 'string') return value;
	if (!isRecord(value)) return '';
	return typeof value.target === 'string'
		? value.target
		: typeof value['reference-value'] === 'string'
			? value['reference-value']
			: '';
}

export async function findOwnedNamesCarriers(
	namespace: Namespace,
	initialHolder: string,
	options: {
		graphql: string;
		fetch: typeof fetch;
		signal?: AbortSignal;
	}
): Promise<NamesCarrierEntry[]> {
	if (!isArweaveId(initialHolder)) return [];

	const results = await Promise.all(
		['execution-device', 'device'].map((deviceTag) => queryOwnedCarriers(deviceTag, initialHolder, options))
	);
	const found = new Map<string, NamesCarrierEntry>();

	for (const node of results.flat()) {
		const name = namespace.byReference[node.id];
		const tags = tagRecord(node.tags);
		const device = tags['execution-device'] ?? tags.device;
		if (
			!name ||
			!device ||
			!CARRIER_DEVICES.has(device) ||
			tags['initial-holder'] !== initialHolder ||
			!isArweaveId(tags['initial-value'] ?? '')
		) {
			continue;
		}
		found.set(node.id, {
			name,
			processId: node.id,
			initialHolder,
			initialValue: tags['initial-value']!,
		});
	}

	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function findPurchasedNamesCarriers(
	namespace: Namespace,
	buyer: string,
	options: {
		graphql: string;
		fetch: typeof fetch;
		signal?: AbortSignal;
	}
): Promise<NamesCarrierCandidate[]> {
	if (!isArweaveId(buyer)) return [];

	const nodes = await queryPurchaseRegistrations(buyer, options);
	const found = new Map<string, NamesCarrierCandidate>();

	for (const node of nodes) {
		if (!node.recipient || node.owner.address !== buyer) continue;
		const name = namespace.byReference[node.recipient];
		const tags = tagRecord(node.tags);
		if (!name || tags.action !== 'register-interest' || !isArweaveId(tags['order-id'] ?? '')) continue;
		found.set(node.recipient, { name, processId: node.recipient });
	}

	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function discoverOfferCandidates(
	namespaceNames: Record<string, string>,
	options: { graphql: string; fetch: typeof fetch; signal?: AbortSignal }
): Promise<OfferCandidate[]> {
	const processIds = new Set(Object.values(namespaceNames));
	const nodes = await queryTransactions(
		options.graphql,
		[{ name: 'action', values: ['make-offer'] }],
		options.fetch,
		options.signal
	);
	return nodes.map(toOfferCandidate).filter((candidate): candidate is OfferCandidate => candidate !== null)
		.filter((candidate) => processIds.has(candidate.processId));
}

export function carrierRecord(name: string, processId: string, state: CarrierState): OwnedName {
	return {
		name,
		referenceId: processId,
		namespaceId: processId,
		processId,
		authority: ownerOfCarrier(state) ?? undefined,
		value: carrierTarget(state.value),
		kind: 'carrier',
		source: 'process',
		carrierState: state,
	};
}

async function queryOwnedCarriers(
	deviceTag: string,
	initialHolder: string,
	options: {
		graphql: string;
		fetch: typeof fetch;
		signal?: AbortSignal;
	}
): Promise<GraphqlNode[]> {
	return queryTransactions(
		options.graphql,
		[
			{ name: deviceTag, values: [...CARRIER_DEVICES] },
			{ name: 'initial-holder', values: [initialHolder] },
		],
		options.fetch,
		options.signal,
		'namespace-carriers-graphql'
	);
}

async function queryPurchaseRegistrations(
	buyer: string,
	options: {
		graphql: string;
		fetch: typeof fetch;
		signal?: AbortSignal;
	}
): Promise<GraphqlNode[]> {
	return queryTransactions(
		options.graphql,
		[{ name: 'action', values: ['register-interest'] }],
		options.fetch,
		options.signal,
		'namespace-purchases-graphql',
		{ owners: [buyer] }
	);
}

async function queryTransactions(
	graphql: string,
	tags: Array<{ name: string; values: string[] }>,
	fetcher: typeof fetch,
	signal?: AbortSignal,
	errorPrefix = 'names-graphql',
	extraVariables: Record<string, unknown> = {}
): Promise<GraphqlNode[]> {
	const nodes: GraphqlNode[] = [];
	let cursor: string | null = null;

	for (let page = 0; page < GRAPHQL_MAX_PAGES; page += 1) {
		const payload = await gqlJson(graphql, {
			query: `query NamesTransactions($cursor: String, $tags: [TagFilter!]!, $owners: [String!]) {
				transactions(first: ${GRAPHQL_PAGE_SIZE}, after: $cursor, sort: HEIGHT_DESC, tags: $tags, owners: $owners) {
					pageInfo { hasNextPage }
					edges {
						cursor
						node {
							id
							recipient
							owner { address }
							block { height timestamp }
							tags { name value }
						}
					}
				}
			}`,
			variables: { cursor, tags, ...extraVariables },
			fetch: fetcher,
			signal,
			errorPrefix,
		});
		const connection = payload?.data?.transactions;
		const edges = Array.isArray(connection?.edges) ? connection.edges : [];
		nodes.push(...edges.map((edge: { node: GraphqlNode }) => edge.node));
		if (!connection?.pageInfo?.hasNextPage || !edges.length) break;
		cursor = edges[edges.length - 1]!.cursor;
	}

	return nodes;
}

function toOfferCandidate(node: GraphqlNode): OfferCandidate | null {
	if (!node.recipient || !isArweaveId(node.recipient) || !isArweaveId(node.id)) return null;
	const tags = tagRecord(node.tags);
	const asking = amount(tags.asking);
	const minimumFee = amount(tags['minimum-fee']) ?? '0';
	const deadline = integer(tags.deadline);
	if (
		tags.action !== 'make-offer' ||
		tags['offer-quantity'] !== '1' ||
		asking === null ||
		deadline === null ||
		!node.block
	) {
		return null;
	}

	return {
		id: node.id,
		processId: node.recipient,
		creator: node.owner.address,
		height: node.block.height,
		timestamp: node.block.timestamp,
		asking,
		minimumFee,
		deadline,
	};
}

async function gqlJson(
	endpoint: string,
	args: {
		query: string;
		variables?: Record<string, unknown>;
		fetch: typeof fetch;
		signal?: AbortSignal;
		errorPrefix: string;
	}
): Promise<any> {
	const response = await args.fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: args.query, variables: args.variables ?? {} }),
		signal: args.signal,
	});
	if (!response.ok) throw new Error(`${args.errorPrefix}-${response.status}`);
	const payload = await response.json();
	if (payload.errors?.length) throw new Error(`${args.errorPrefix}-error`);
	return payload;
}

function tagRecord(tags: unknown): Record<string, string> {
	if (!Array.isArray(tags)) return {};
	const result: Record<string, string> = {};
	for (const tag of tags) {
		if (!isRecord(tag)) continue;
		const name = text(tag.name).toLowerCase();
		const value = text(tag.value);
		if (name) result[name] = value;
	}
	return result;
}

function unwrapState(value: unknown): Record<string, unknown> {
	let held = value;
	for (let depth = 0; depth < 3; depth += 1) {
		if (typeof held === 'string') {
			held = JSON.parse(held);
			continue;
		}
		if (isRecord(held) && Object.keys(held).length <= 4 && 'body' in held) {
			held = held.body;
			continue;
		}
		break;
	}
	if (!isRecord(held)) throw new TypeError('invalid-carrier-state');
	return held;
}

function stringRecord(value: unknown): Record<string, string> | null {
	if (!isRecord(value)) return null;
	const result: Record<string, string> = {};
	for (const [key, held] of Object.entries(value)) {
		const parsed = amount(held);
		if (parsed !== null) result[key] = parsed;
	}
	return result;
}

function amount(value: unknown): string | null {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
	if (typeof value !== 'string' || !UNSIGNED_INTEGER.test(value)) return null;
	return value;
}

function integer(value: unknown): number | null {
	const held = amount(value);
	if (held === null) return null;
	const parsed = Number(held);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function timeoutSignal(parent: AbortSignal | undefined, timeout: number): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const abort = () => controller.abort(parent?.reason);
	if (parent?.aborted) abort();
	else parent?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error('compute-provider-timeout')), timeout);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener('abort', abort);
		},
	};
}

function delay(duration: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, duration);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}

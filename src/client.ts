import type { Address, OwnedName, OwnedReference, ResolvedName, ResolvedReference } from './types.js';
import { authorityOf, isInit } from './identity.js';
import { currentState, effectiveValue } from './compute.js';
import { buildInit, buildSet, DEVICE } from './messages.js';
import { discoverSets, discoverReferencesByAuthority, fetchMessageById, PHASE2_BOOTSTRAP_OWNER } from './discovery.js';
import { parseNamespace, type Namespace } from './namespace.js';
import {
	findNamesNamespaceEntries,
	findOwnedNamesCarriers,
	findPurchasedNamesCarriers,
	carrierRecord,
	isCarrierProcess,
	readCarrierState,
	resolveNamesNamespaceReference,
	waitForCarrierState,
} from './names.js';
import type { CarrierReadPathOption, CarrierState, SwapOrder } from './names.js';
import {
	DEFAULT_CARRIER_RESERVATION_INCLUSION_MARGIN,
	assertSafeCarrierPurchaseOrder,
	buildCarrierCancelOrder,
	buildCarrierMakeOffer,
	buildCarrierPayment,
	buildCarrierRegisterInterest,
	buildCarrierSetTarget,
	buildCarrierTransfer,
	type AmountLike,
} from './carrier-transactions.js';
import type { SendTransactionOptions, Signer, TransactionMessage } from './signer.js';

/** The phase-2 namespace root reference. Override via config. */
export const PHASE2_NAMESPACE = 'w0eqd43OMzzXr-5yhFC-LkgifQqih8YEPb4mLt6VSZo';
/** The current mainnet Permaweb Names namespace root reference. */
export const MAINNET_NAMES_NAMESPACE = 'fQXYPE9MAcfI1wV2CwJ3sJIhgT9btBOlYFOKFDGhAs0';

export interface ReferenceClientConfig {
	/** Tx + GraphQL base. Default https://arweave.net; use any gateway you like. */
	gateway?: string;
	/** GraphQL endpoint. Default `${gateway}/graphql`. */
	graphql?: string;
	/** Bundler for the update path (plain POST of a signed data item). Default
	 *  https://up.arweave.net. No Turbo SDK; set your own to override. */
	bundler?: string;
	/** Namespace root reference or manifest id, used to attach names in
	 *  reads. Defaults to the mainnet Permaweb Names namespace; set null to skip. */
	namespace?: string | null;
	/** HyperBEAM/gateway node origin used to read carrier process state. */
	node?: string;
	/** Carrier process read path(s). Default tries `now`, then `compute`. */
	carrierReadPath?: CarrierReadPathOption;
	/** Trusted bootstrap publishers for authority-tagged reference inits. */
	trustedPublishers?: Address[];
	/** Signer for the update path (fromWallet / fromJwk). Required only for writes. */
	signer?: Signer;
	/** fetch implementation; defaults to the global. Pass one where there is none. */
	fetch?: typeof fetch;
}

const DEFAULTS = {
	gateway: 'https://arweave.net',
	bundler: 'https://up.arweave.net',
};
const MAX_NAMESPACE_REFERENCE_DEPTH = 10;
type TransactionSigner = Signer & { sendTransaction: NonNullable<Signer['sendTransaction']> };
const UNSIGNED_WINSTON = /^(?:0|[1-9]\d*)$/;

/**
 * Developer utility for `reference@1.0`. Reads resolve a reference's current value
 * from GraphQL on any gateway (stateless). Updates build a normal Arweave tx and
 * POST it to a bundler. `findReferences` lists the references a wallet controls.
 */
export class ReferenceClient {
	readonly gateway: string;
	readonly graphql: string;
	readonly bundler: string;
	readonly namespace: string | null;
	readonly node: string;
	readonly trustedPublishers: Address[];
	readonly signer?: Signer;
	private readonly fetchImpl: typeof fetch;
	private readonly carrierReadPath?: CarrierReadPathOption;
	private namespaceMemo?: Promise<Namespace>;

	constructor(config: ReferenceClientConfig = {}) {
		this.gateway = (config.gateway ?? DEFAULTS.gateway).replace(/\/+$/, '');
		this.graphql = config.graphql ?? `${this.gateway}/graphql`;
		this.bundler = (config.bundler ?? DEFAULTS.bundler).replace(/\/+$/, '');
		this.namespace = config.namespace === undefined ? MAINNET_NAMES_NAMESPACE : config.namespace;
		this.node = (config.node ?? this.gateway).replace(/\/+$/, '');
		this.carrierReadPath = config.carrierReadPath;
		this.trustedPublishers = config.trustedPublishers ?? [PHASE2_BOOTSTRAP_OWNER];
		this.signer = config.signer;
		const f = config.fetch ?? (globalThis.fetch as typeof fetch | undefined);
		if (!f) throw new Error('No fetch available; pass { fetch } in environments without a global fetch');
		this.fetchImpl = f;
	}

	// --- read (GraphQL, any gateway) ---

	/** Resolve a reference to its current state (its `init` plus the folded updates). */
	async getReference(referenceId: string): Promise<ResolvedReference | undefined> {
		const init = await fetchMessageById({ endpoint: this.graphql, fetch: this.fetchImpl, id: referenceId });
		if (!init) return undefined;
		if (init.message.device !== DEVICE || !isInit(init.message)) return undefined;
		const authority: Address | undefined = authorityOf(init.message, init.committers);
		const candidates = await discoverSets({ endpoint: this.graphql, fetch: this.fetchImpl, referenceId, authority });
		const state = currentState({ init: init.message, authority, candidates });
		return {
			id: referenceId,
			authority,
			value: effectiveValue(state.message),
			timestamp: state.timestamp,
			source: state.source,
		};
	}

	/** Convenience: the current value of a reference. Throws if the reference is unknown. */
	async resolveReference(referenceId: string): Promise<unknown> {
		const ref = await this.getReference(referenceId);
		if (!ref) throw new Error(`reference not found: ${referenceId}`);
		return ref.value;
	}

	/** Resolve a namespace name to its current reference state. */
	async getName(name: string): Promise<ResolvedName | undefined> {
		const ns = await this.loadNamespace();
		const namespaceId = ns?.names[name];
		if (!namespaceId) return undefined;
		if (await isCarrierProcess(namespaceId, { graphql: this.graphql, fetch: this.fetchImpl })) {
			const { state } = await readCarrierState(namespaceId, {
				provider: this.node,
				fetch: this.fetchImpl,
				path: this.carrierReadPath,
			});
			return carrierRecord(name, namespaceId, state);
		}
		const referenceId = await resolveNamesNamespaceReference(namespaceId, {
			gateway: this.gateway,
			fetch: this.fetchImpl,
		});
		const ref = await this.getReference(referenceId);
		if (!ref) return undefined;
		return {
			name,
			referenceId,
			namespaceId,
			authority: ref.authority,
			value: ref.value,
			timestamp: ref.timestamp,
			source: ref.source,
			kind: 'reference',
		};
	}

	/** Convenience: the current value of a namespace name. Throws if the name is unknown. */
	async resolveName(name: string): Promise<unknown> {
		const ref = await this.getName(name);
		if (!ref) throw new Error(`name not found: ${name}`);
		return ref.value;
	}

	/**
	 * The references a wallet controls (its `authority`), via GraphQL. Each carries
	 * its name pulled from the namespace (null if the reference is not in it), its
	 * recorded value, and `name-source` / `date-registered` metadata when present.
	 */
	async findReferences(authority: Address): Promise<OwnedReference[]> {
		const refs = await discoverReferencesByAuthority({
			endpoint: this.graphql,
			fetch: this.fetchImpl,
			authority,
			trustedPublishers: this.trustedPublishers,
		});
		const ns = await this.loadNamespace();
		return refs.map((r) => ({
			referenceId: r.id,
			name: ns?.byReference[r.id] ?? null,
			value: r.message['reference-value'],
			nameSource: typeof r.message['name-source'] === 'string' ? r.message['name-source'] : undefined,
			dateRegistered: typeof r.message['date-registered'] === 'string' ? r.message['date-registered'] : undefined,
		}));
	}

	/**
	 * Names a wallet currently controls in the configured namespace.
	 *
	 * This includes legacy `reference@1.0` names and mainnet carrier
	 * processes. Purchased carrier-backed names are discovered from registration txs
	 * and then verified against current process state.
	 */
	async findNamesByOwner(authority: Address): Promise<OwnedName[]> {
		const [refs, ns] = await Promise.all([this.findReferences(authority), this.loadNamespace()]);
		const namespace = ns ?? { names: {}, byReference: {} };
		const referenceEntries = findNamesNamespaceEntries(
			namespace,
			refs.map((ref) => ref.referenceId)
		);
		const referenceRecords: Array<OwnedName | null> = await Promise.all(
			referenceEntries.map(async (entry) => {
				const state = await this.getReference(entry.referenceId);
				if (!state) return null;
				const record: OwnedName = {
					name: entry.name,
					referenceId: entry.referenceId,
					namespaceId: entry.namespaceId,
					authority: state.authority,
					value: state.value,
					timestamp: state.timestamp,
					source: state.source,
					kind: 'reference' as const,
				};
				return record;
			})
		);

		const carrierOptions = { graphql: this.graphql, fetch: this.fetchImpl };
		const [ownedCarriers, purchasedCarriers] = await Promise.all([
			findOwnedNamesCarriers(namespace, authority, carrierOptions),
			findPurchasedNamesCarriers(namespace, authority, carrierOptions),
		]);
		const candidates = new Map<string, { name: string; processId: string; initialValue?: string; initialHolder?: string }>();
		for (const carrier of ownedCarriers) {
			candidates.set(carrier.processId, {
				name: carrier.name,
				processId: carrier.processId,
				initialHolder: carrier.initialHolder,
				initialValue: carrier.initialValue,
			});
		}
		for (const carrier of purchasedCarriers) {
			if (!candidates.has(carrier.processId)) candidates.set(carrier.processId, carrier);
		}

		const carrierRecords: Array<OwnedName | null> = await Promise.all(
			[...candidates.values()].map(async (candidate) => {
				const { state } = await readCarrierState(candidate.processId, {
					provider: this.node,
					fetch: this.fetchImpl,
					path: this.carrierReadPath,
				});
				const record = carrierRecord(candidate.name, candidate.processId, state);
				return record.authority === authority ? record : null;
			})
		);

		const records = [...referenceRecords, ...carrierRecords].filter((record): record is OwnedName => record !== null);
		return records.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Fetch a raw document by id via /raw/ (so a manifest is returned, not resolved). */
	async fetchRaw(id: string): Promise<string> {
		const res = await this.fetchImpl(`${this.gateway}/raw/${id}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`raw fetch failed: ${res.status} for ${id}`);
		return res.text();
	}

	/** Resolve the namespace root reference, then fetch + index its manifest. */
	private loadNamespace(): Promise<Namespace> | undefined {
		if (!this.namespace) return undefined;
		if (!this.namespaceMemo) {
			this.namespaceMemo = (async () => {
				const manifestId = await this.resolveNamespaceManifestId(this.namespace!);
				return parseNamespace(await this.fetchNamespaceManifest(manifestId));
			})();
		}
		return this.namespaceMemo;
	}

	private async fetchNamespaceManifest(manifestId: string): Promise<string> {
		try {
			const res = await this.fetchImpl(`${this.gateway}/${manifestId}/serialize~json@1.0`, {
				headers: { accept: 'application/json' },
			});
			if (res.ok) {
				const envelope = await res.json();
				if (typeof envelope?.data === 'string') return envelope.data;
			}
		} catch {
			// Raw transaction data remains the fallback.
		}
		return this.fetchRaw(manifestId);
	}

	private async resolveNamespaceManifestId(namespace: string): Promise<string> {
		let current = namespace;
		const seen = new Set<string>();
		for (let depth = 0; depth < MAX_NAMESPACE_REFERENCE_DEPTH; depth++) {
			if (seen.has(current)) throw new Error(`namespace reference cycle detected: ${current}`);
			seen.add(current);

			const next = await this.resolveTrustedNamespaceReference(current, depth === 0);
			if (!next) return current;
			current = next;
		}
		throw new Error(`namespace reference chain is too deep: ${namespace}`);
	}

	private async resolveTrustedNamespaceReference(referenceId: string, isRoot: boolean): Promise<string | undefined> {
		const init = await fetchMessageById({ endpoint: this.graphql, fetch: this.fetchImpl, id: referenceId });
		if (!init || init.message.device !== DEVICE || !isInit(init.message)) return undefined;

		const owner = init.committers[0];
		const authority = authorityOf(init.message, init.committers);
		const trusted = new Set(this.trustedPublishers);
		if (!owner || !authority || !trusted.has(owner) || !trusted.has(authority)) {
			const kind = isRoot ? 'root' : 'reference';
			throw new Error(`namespace ${kind} is not owned by trusted bootstrap publisher: ${referenceId}`);
		}

		const candidates = await discoverSets({
			endpoint: this.graphql,
			fetch: this.fetchImpl,
			referenceId,
			authority,
		});
		const state = currentState({ init: init.message, authority, candidates });
		const value = effectiveValue(state.message);
		if (typeof value !== 'string') {
			const kind = isRoot ? 'root' : 'reference';
			throw new Error(`namespace ${kind} does not resolve to a manifest id: ${referenceId}`);
		}
		return value;
	}

	// --- update (Arweave tx -> bundler) ---

	private requireSigner(): Signer {
		if (!this.signer) throw new Error('No signer configured; pass { signer } (fromWallet / fromJwk) to write');
		return this.signer;
	}

	private requireTransactionSigner(): TransactionSigner {
		const signer = this.requireSigner();
		if (!signer.sendTransaction) {
			throw new Error('Signer does not support carrier process transactions; use fromWallet/fromJwk from this SDK');
		}
		return signer as TransactionSigner;
	}

	private carrierTxOptions(expectedSigner: string): SendTransactionOptions {
		return { gateway: this.gateway, fetch: this.fetchImpl, expectedSigner };
	}

	private async readLiveCarrierState(processId: string): Promise<CarrierState> {
		const { state } = await readCarrierState(processId, {
			provider: this.node,
			fetch: this.fetchImpl,
			path: this.carrierReadPath,
		});
		return state;
	}

	private async requireCarrierHolder(processId: string, signer: Signer): Promise<{ signerAddress: string; state: CarrierState }> {
		const signerAddress = await signer.address();
		const state = await this.readLiveCarrierState(processId);
		if (state.balances[signerAddress] !== '1') {
			throw new Error(`signer is not carrier holder for ${processId}`);
		}
		return { signerAddress, state };
	}

	private async carrierTip(state: CarrierState, currentHeight: number | undefined): Promise<number> {
		const height = currentHeight ?? await this.fetchGatewayHeight();
		if (!Number.isSafeInteger(height) || height < 0) throw new TypeError('invalid-current-height');
		return Math.max(height, state.swapHeight);
	}

	private async fetchGatewayHeight(): Promise<number> {
		const response = await this.fetchImpl(`${this.gateway}/info`, { headers: { accept: 'application/json' } });
		if (!response.ok) throw new Error(`gateway info fetch failed: ${response.status}`);
		const body = await response.json();
		const height = Number((body as { height?: unknown }).height);
		if (!Number.isSafeInteger(height) || height < 0) throw new Error('gateway info did not include a valid height');
		return height;
	}

	private async fetchGatewayAmount(path: string, description: string): Promise<bigint> {
		const response = await this.fetchImpl(`${this.gateway}${path}`, { headers: { accept: 'text/plain' } });
		if (!response.ok) throw new Error(`${description} lookup failed: ${response.status}`);
		const amount = (await response.text()).trim();
		if (!UNSIGNED_WINSTON.test(amount)) throw new Error(`${description} lookup returned an invalid amount`);
		return BigInt(amount);
	}

	private async fetchWalletBalance(address: string): Promise<bigint> {
		return this.fetchGatewayAmount(`/wallet/${address}/balance`, 'wallet balance');
	}

	private async estimateTransactionCost(message: TransactionMessage): Promise<bigint> {
		const quotedReward = await this.fetchGatewayAmount(`/price/0/${message.target}`, 'transaction price');
		const rewardFloor = message.rewardFloor === undefined ? 0n : amountToBigInt(message.rewardFloor, 'transaction reward floor');
		const reward = quotedReward > rewardFloor ? quotedReward : rewardFloor;
		const quantity = amountToBigInt(message.quantity ?? '0', 'transaction quantity');
		return reward + quantity;
	}

	private async requireWalletBalance(address: string, messages: TransactionMessage[]): Promise<void> {
		const costs = await Promise.all(messages.map((message) => this.estimateTransactionCost(message)));
		const needed = costs.reduce((sum, cost) => sum + cost, 0n);
		const balance = await this.fetchWalletBalance(address);
		if (balance < needed) {
			throw new Error(`insufficient wallet balance for carrier transaction: need ${needed}, have ${balance}`);
		}
	}

	private async sendCarrierTransaction(
		signer: TransactionSigner,
		signerAddress: string,
		message: TransactionMessage
	): Promise<{ id: string }> {
		await this.requireWalletBalance(signerAddress, [message]);
		return signer.sendTransaction(message, this.carrierTxOptions(signerAddress));
	}

	/** Create a new reference (an `init`). The resulting data-item id is the reference id. */
	async createReference(opts: { value?: string; authority?: string; timestamp?: number } = {}): Promise<{ referenceId: string }> {
		const signer = this.requireSigner();
		const authority = opts.authority ?? await signer.address();
		const { tags } = buildInit({ value: opts.value, authority, timestamp: opts.timestamp ?? Date.now() });
		const { id } = await signer.send({ tags, data: ' ' }, { bundler: this.bundler, fetch: this.fetchImpl });
		return { referenceId: id };
	}

	/** Update a reference's value. The signer must be the reference's authority. */
	async updateReference(referenceId: string, opts: { value?: string; timestamp?: number } = {}): Promise<{ id: string }> {
		const signer = this.requireSigner();
		const current = await this.getReference(referenceId);
		if (!current) throw new Error(`reference not found: ${referenceId}`);
		const signerAddress = await signer.address();
		if (current.authority !== signerAddress) {
			throw new Error(`signer is not reference authority for ${referenceId}`);
		}
		const timestamp = opts.timestamp ?? Math.max(Date.now(), current.timestamp + 1);
		const { tags } = buildSet({ referenceId, value: opts.value, timestamp });
		return signer.send({ tags, data: ' ' }, { bundler: this.bundler, fetch: this.fetchImpl });
	}

	/** Update a carrier-backed name's target. Requires the signer to hold the live carrier unit. */
	async setCarrierTarget(processId: string, target: string): Promise<{ id: string }> {
		const signer = this.requireTransactionSigner();
		const { signerAddress } = await this.requireCarrierHolder(processId, signer);
		return this.sendCarrierTransaction(signer, signerAddress, buildCarrierSetTarget(processId, target));
	}

	/** Alias for callers migrating from `updateReference` terminology. */
	async updateCarrierTarget(processId: string, target: string): Promise<{ id: string }> {
		return this.setCarrierTarget(processId, target);
	}

	/** Transfer the live carrier unit to another wallet. Requires the signer to hold it now. */
	async transferCarrier(processId: string, recipient: string): Promise<{ id: string }> {
		const signer = this.requireTransactionSigner();
		const { signerAddress } = await this.requireCarrierHolder(processId, signer);
		return this.sendCarrierTransaction(signer, signerAddress, buildCarrierTransfer(processId, recipient));
	}

	/** Create a live swap order for a carrier. Requires the signer to hold the carrier unit now. */
	async makeCarrierOffer(
		processId: string,
		opts: { asking: AmountLike; currentHeight?: number; minimumFee?: AmountLike; deadline?: number }
	): Promise<{ id: string }> {
		const signer = this.requireTransactionSigner();
		const { signerAddress, state } = await this.requireCarrierHolder(processId, signer);
		const liveOrder = Object.values(state.orders).find((order) => order.quantity === 1 && (order.status === 'open' || order.status === 'reserved'));
		if (liveOrder) throw new Error(`carrier already has a live order: ${liveOrder.orderId}`);
		const currentHeight = await this.carrierTip(state, opts.currentHeight);
		return this.sendCarrierTransaction(signer, signerAddress, buildCarrierMakeOffer(processId, { ...opts, currentHeight }));
	}

	/** Alias for the swap terminology used in the carrier process. */
	async makeCarrierOrder(
		processId: string,
		opts: { asking: AmountLike; currentHeight?: number; minimumFee?: AmountLike; deadline?: number }
	): Promise<{ id: string }> {
		return this.makeCarrierOffer(processId, opts);
	}

	/** Cancel an open carrier swap order. Requires the signer to be the live order creator. */
	async cancelCarrierOrder(processId: string, orderId: string): Promise<{ id: string }> {
		const signer = this.requireTransactionSigner();
		const signerAddress = await signer.address();
		const state = await this.readLiveCarrierState(processId);
		const order = state.orders[orderId];
		if (!order || order.status !== 'open') throw new Error(`carrier order is not open: ${orderId}`);
		if (order.creator !== signerAddress) throw new Error(`signer is not carrier order creator for ${orderId}`);
		return this.sendCarrierTransaction(signer, signerAddress, buildCarrierCancelOrder(processId, orderId));
	}

	/** Register buy interest for an exact live carrier order. */
	async registerCarrierInterest(
		processId: string,
		order: SwapOrder,
		opts: { currentHeight?: number; inclusionMargin?: number } = {}
	): Promise<{ id: string }> {
		const signer = this.requireTransactionSigner();
		const buyer = await signer.address();
		const state = await this.readLiveCarrierState(processId);
		const tip = await this.carrierTip(state, opts.currentHeight);
		const live = this.requirePurchasableCarrierOrder(processId, state, order, buyer, tip, {
			inclusionMargin: opts.inclusionMargin,
			allowOpen: true,
			allowReserved: false,
		});
		return this.sendCarrierTransaction(signer, buyer, buildCarrierRegisterInterest(processId, live));
	}

	/** Pay the seller for an exact live carrier order reserved by the signer. */
	async payCarrierOrder(
		processId: string,
		order: SwapOrder,
		opts: { currentHeight?: number; inclusionMargin?: number } = {}
	): Promise<{ id: string }> {
		const signer = this.requireTransactionSigner();
		const buyer = await signer.address();
		const state = await this.readLiveCarrierState(processId);
		const tip = await this.carrierTip(state, opts.currentHeight);
		const live = this.requirePurchasableCarrierOrder(processId, state, order, buyer, tip, {
			inclusionMargin: opts.inclusionMargin,
			allowOpen: false,
			allowReserved: true,
		});
		return this.sendCarrierTransaction(signer, buyer, buildCarrierPayment(live));
	}

	/**
	 * Buy an exact live carrier order. The signer signs all required transactions
	 * only from live state: open orders register interest, wait for the buyer's
	 * live reservation, then sign payment; reserved orders for the signer pay only.
	 */
	async buyCarrierOrder(
		processId: string,
		order: SwapOrder,
		opts: { currentHeight?: number; inclusionMargin?: number; reservationTimeout?: number; reservationInterval?: number } = {}
	): Promise<{ registrationId?: string; paymentId: string }> {
		const signer = this.requireTransactionSigner();
		const buyer = await signer.address();
		const state = await this.readLiveCarrierState(processId);
		const tip = await this.carrierTip(state, opts.currentHeight);
		const live = this.requirePurchasableCarrierOrder(processId, state, order, buyer, tip, {
			inclusionMargin: opts.inclusionMargin,
			allowOpen: true,
			allowReserved: true,
		});
		if (live.status === 'reserved') {
			const payment = await this.sendCarrierTransaction(signer, buyer, buildCarrierPayment(live));
			return { paymentId: payment.id };
		}

		const registrationMessage = buildCarrierRegisterInterest(processId, live);
		const paymentMessage = buildCarrierPayment(live);
		await this.requireWalletBalance(buyer, [registrationMessage, paymentMessage]);
		const registration = await this.sendCarrierTransaction(signer, buyer, registrationMessage);
		await waitForCarrierState(
			processId,
			(next) => {
				const held = next.orders[live.orderId];
				return Boolean(held && held.status === 'reserved' && held.buyer === buyer);
			},
			{
				provider: this.node,
				fetch: this.fetchImpl,
				path: this.carrierReadPath,
				timeout: opts.reservationTimeout,
				interval: opts.reservationInterval,
			}
		);
		const payment = await this.payCarrierOrder(processId, order, {
			inclusionMargin: opts.inclusionMargin,
		});
		return { registrationId: registration.id, paymentId: payment.id };
	}

	private requirePurchasableCarrierOrder(
		processId: string,
		state: CarrierState,
		expected: SwapOrder,
		buyer: string,
		currentHeight: number,
		options: { inclusionMargin?: number; allowOpen: boolean; allowReserved: boolean }
	): SwapOrder {
		assertSafeCarrierPurchaseOrder(expected);
		const live = state.orders[expected.orderId];
		if (!live) throw new Error(`carrier order not found: ${expected.orderId}`);
		assertSafeCarrierPurchaseOrder(live);
		const sameEconomics =
			live.creator === expected.creator &&
			live.recipient === expected.recipient &&
			live.asking === expected.asking &&
			live.deposit === expected.deposit &&
			live.minimumFee === expected.minimumFee &&
			live.deadline === expected.deadline &&
			live.createdAt === expected.createdAt &&
			live.quantity === expected.quantity;
		if (!sameEconomics) throw new Error(`live carrier order changed: ${expected.orderId}`);
		const margin = options.inclusionMargin ?? DEFAULT_CARRIER_RESERVATION_INCLUSION_MARGIN;
		if (!Number.isSafeInteger(margin) || margin < 0) throw new TypeError('invalid-carrier-inclusion-margin');
		if (live.deadline < currentHeight + margin) throw new Error(`carrier order deadline is too close: ${expected.orderId}`);
		if (state.balances[live.creator] !== '0') throw new Error(`carrier order is not escrowed: ${expected.orderId}`);
		if (state.balances[buyer] === '1') throw new Error(`buyer already holds carrier: ${processId}`);
		if (options.allowOpen && live.status === 'open') return live;
		const reservedForBuyer = live.status === 'reserved' &&
			live.buyer === buyer &&
			(live.reservedUntil ?? -1) >= currentHeight + margin;
		if (options.allowReserved && reservedForBuyer) return live;
		throw new Error(`carrier order is not purchasable: ${expected.orderId}`);
	}
}

function amountToBigInt(value: string, description: string): bigint {
	if (!UNSIGNED_WINSTON.test(value)) throw new Error(`${description} is invalid`);
	return BigInt(value);
}

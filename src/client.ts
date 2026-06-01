import type { Address, OwnedReference, ResolvedReference } from './types.js';
import { authorityOf, isInit } from './identity.js';
import { currentState, effectiveValue } from './compute.js';
import { buildInit, buildSet, DEVICE } from './messages.js';
import { discoverSets, discoverReferencesByAuthority, fetchMessageById, PHASE2_BOOTSTRAP_OWNER } from './discovery.js';
import { parseNamespace, type Namespace } from './namespace.js';
import type { Signer } from './signer.js';

/** The fixed phase-2 namespace snapshot (name -> reference-id). Override via config. */
export const PHASE2_NAMESPACE = 'NgWK2T4qon7zvNHMm_x0Ggu72wehg--J8Wjbk5Cas5M';

export interface ReferenceClientConfig {
	/** Tx + GraphQL base. Default https://arweave.net; use any gateway you like. */
	gateway?: string;
	/** GraphQL endpoint. Default `${gateway}/graphql`. */
	graphql?: string;
	/** Bundler for the update path (plain POST of a signed data item). Default
	 *  https://up.arweave.net. No Turbo SDK; set your own to override. */
	bundler?: string;
	/** Namespace manifest id (name <-> reference-id), used to attach names in
	 *  `findReferences`. Defaults to the fixed phase-2 snapshot; set null to skip. */
	namespace?: string | null;
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
	readonly trustedPublishers: Address[];
	readonly signer?: Signer;
	private readonly fetchImpl: typeof fetch;
	private namespaceMemo?: Promise<Namespace>;

	constructor(config: ReferenceClientConfig = {}) {
		this.gateway = (config.gateway ?? DEFAULTS.gateway).replace(/\/+$/, '');
		this.graphql = config.graphql ?? `${this.gateway}/graphql`;
		this.bundler = (config.bundler ?? DEFAULTS.bundler).replace(/\/+$/, '');
		this.namespace = config.namespace === undefined ? PHASE2_NAMESPACE : config.namespace;
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

	/** Fetch a raw document by id via /raw/ (so a manifest is returned, not resolved). */
	async fetchRaw(id: string): Promise<string> {
		const res = await this.fetchImpl(`${this.gateway}/raw/${id}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`raw fetch failed: ${res.status} for ${id}`);
		return res.text();
	}

	/** Fetch + index the namespace (immutable snapshot), memoized. Undefined if disabled. */
	private loadNamespace(): Promise<Namespace> | undefined {
		if (!this.namespace) return undefined;
		if (!this.namespaceMemo) this.namespaceMemo = this.fetchRaw(this.namespace).then(parseNamespace);
		return this.namespaceMemo;
	}

	// --- update (Arweave tx -> bundler) ---

	private requireSigner(): Signer {
		if (!this.signer) throw new Error('No signer configured; pass { signer } (fromWallet / fromJwk) to write');
		return this.signer;
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
}

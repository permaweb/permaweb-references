import type { Address, ResolvedReference } from './types.js';
import { authorityOf } from './identity.js';
import { currentState, effectiveValue } from './compute.js';
import { buildInit, buildSet } from './messages.js';
import { discoverSets, fetchMessageById } from './discovery.js';
import type { Signer } from './signer.js';

export interface ReferenceClientConfig {
	/** Tx + GraphQL base. Default https://arweave.net; use any gateway you like. */
	gateway?: string;
	/** GraphQL endpoint. Default `${gateway}/graphql`. */
	graphql?: string;
	/** Bundler for the update path (plain POST of a signed data item). Default
	 *  https://up.arweave.net. No Turbo SDK; set your own (e.g. a HyperBEAM
	 *  bundler at /~bundler@1.0/tx) to override. */
	bundler?: string;
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
 * from GraphQL on any gateway (stateless: caching/freshness are the caller's
 * concern). Updates build a normal Arweave tx and POST it to a bundler.
 */
export class ReferenceClient {
	readonly gateway: string;
	readonly graphql: string;
	readonly bundler: string;
	readonly signer?: Signer;
	private readonly fetchImpl: typeof fetch;

	constructor(config: ReferenceClientConfig = {}) {
		this.gateway = (config.gateway ?? DEFAULTS.gateway).replace(/\/+$/, '');
		this.graphql = config.graphql ?? `${this.gateway}/graphql`;
		this.bundler = (config.bundler ?? DEFAULTS.bundler).replace(/\/+$/, '');
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

	// --- update (Arweave tx -> bundler) ---

	private requireSigner(): Signer {
		if (!this.signer) throw new Error('No signer configured; pass { signer } (fromWallet / fromJwk) to write');
		return this.signer;
	}

	/** Create a new reference (an `init`). The resulting data-item id is the reference id. */
	async createReference(opts: { value?: string; authority?: string; timestamp?: number } = {}): Promise<{ referenceId: string }> {
		const signer = this.requireSigner();
		const { tags } = buildInit({ value: opts.value, authority: opts.authority, timestamp: opts.timestamp ?? Date.now() });
		const { id } = await signer.send({ tags, data: ' ' });
		return { referenceId: id };
	}

	/** Update a reference's value. The signer must be the reference's authority. */
	async updateReference(referenceId: string, opts: { value?: string; timestamp?: number } = {}): Promise<{ id: string }> {
		const signer = this.requireSigner();
		const { tags } = buildSet({ referenceId, value: opts.value, timestamp: opts.timestamp ?? Date.now() });
		return signer.send({ tags, data: ' ' });
	}
}

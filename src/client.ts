import type { Address, ReferenceMessage, ResolvedReference } from './types.js';
import { authorityOf } from './identity.js';
import { currentState, effectiveValue } from './compute.js';
import { buildInit, buildSet, buildPointer } from './messages.js';
import { discoverSets, discoverInitsByOwner, fetchMessageById } from './discovery.js';
import { parseManifest, listEntries, lookupEntry } from './directory.js';
import type { DirectoryEntry, ListOptions, ListResult, ParsedDirectory } from './directory.js';
import type { Signer } from './signer.js';

export interface ReferenceClientConfig {
	/** Tx + GraphQL base. Default https://arweave.net (override with your own). */
	gateway?: string;
	/** GraphQL endpoint. Default `${gateway}/graphql`. */
	graphql?: string;
	/** Bundler for the write path (plain POST of signed data items). Default
	 *  https://up.arweave.net. No Turbo SDK; bring your own (e.g. a HyperBEAM
	 *  bundler at /~bundler@1.0/tx) by setting this. */
	bundler?: string;
	/** Namespace reference-set id, for name resolution / listing. */
	namespace?: string;
	/** Opt-in client-side commitment verification (§4, §10). Default false (gateway trusted). */
	verify?: boolean;
	/** Signer for the write path (fromWallet / fromJwk). Required only for writes. */
	signer?: Signer;
	/** fetch implementation; defaults to the global. Pass one in environments without it. */
	fetch?: typeof fetch;
}

export interface ResolveOptions {
	verify?: boolean;
}

const DEFAULTS = {
	gateway: 'https://arweave.net',
	bundler: 'https://up.arweave.net',
	verify: false,
};

/**
 * Stateless client for `reference@1.0`. Every read does its I/O fresh; caching,
 * dedup, and freshness are the caller's concern (React Query/SWR on the frontend,
 * the gateway/CDN and node on the backend). For "list then resolve a few", call
 * `getDirectory()` once and reuse it with the exported `listEntries`/`lookupEntry`.
 */
export class ReferenceClient {
	readonly gateway: string;
	readonly graphql: string;
	readonly bundler: string;
	readonly namespace?: string;
	readonly verify: boolean;
	readonly signer?: Signer;
	private readonly fetchImpl: typeof fetch;

	constructor(config: ReferenceClientConfig = {}) {
		this.gateway = (config.gateway ?? DEFAULTS.gateway).replace(/\/+$/, '');
		this.graphql = config.graphql ?? `${this.gateway}/graphql`;
		this.bundler = (config.bundler ?? DEFAULTS.bundler).replace(/\/+$/, '');
		this.namespace = config.namespace;
		this.verify = config.verify ?? DEFAULTS.verify;
		this.signer = config.signer;
		const f = config.fetch ?? (globalThis.fetch as typeof fetch | undefined);
		if (!f) throw new Error('No fetch available; pass { fetch } in environments without a global fetch');
		this.fetchImpl = f;
	}

	// --- references: read (§4–5) ---

	/** Resolve a reference to its current state, trustless via the gateway. */
	async getReference(referenceId: string, opts: ResolveOptions = {}): Promise<ResolvedReference | undefined> {
		if (opts.verify ?? this.verify) {
			// Forward-compatible: the verify path (fetch + signature check, §4/§10)
			// lands in the verify phase. Fail loud rather than imply a guarantee.
			throw new Error('verify: true is not implemented yet; client-side commitment verification is a later phase');
		}
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

	/** Convenience: the current effective value of a reference. Throws if unknown. */
	async resolveReference(referenceId: string, opts: ResolveOptions = {}): Promise<unknown> {
		const ref = await this.getReference(referenceId, opts);
		if (!ref) throw new Error(`reference not found: ${referenceId}`);
		return ref.value;
	}

	// --- directory / names: read (§9) ---

	private requireNamespace(ns?: string): string {
		const id = ns ?? this.namespace;
		if (!id) throw new Error('No namespace configured; pass { namespace } to the client or the call');
		return id;
	}

	/** Fetch a raw document by id via /raw/ (so a manifest is returned, not resolved). */
	async fetchRaw(id: string): Promise<string> {
		const res = await this.fetchImpl(`${this.gateway}/raw/${id}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`raw fetch failed: ${res.status} for ${id}`);
		return res.text();
	}

	/** The current namespace directory: namespace reference -> doc id -> decoded paths. */
	async getDirectory(opts: { namespace?: string } = {}): Promise<ParsedDirectory> {
		const ns = this.requireNamespace(opts.namespace);
		const docId = await this.resolveReference(ns);
		if (typeof docId !== 'string' || !docId) {
			throw new Error('namespace reference did not resolve to a directory document id');
		}
		const dir = parseManifest(await this.fetchRaw(docId));
		dir.id = docId;
		return dir;
	}

	/** List/search/paginate names in the namespace directory. */
	async list(opts: ListOptions & { namespace?: string } = {}): Promise<ListResult> {
		const dir = await this.getDirectory({ namespace: opts.namespace });
		return listEntries(dir.paths, opts);
	}

	/** Find a single name's directory entry. */
	async lookup(name: string, opts: { namespace?: string } = {}): Promise<DirectoryEntry | null> {
		const dir = await this.getDirectory({ namespace: opts.namespace });
		return lookupEntry(dir.paths, name);
	}

	/**
	 * Resolve a name to its directory entry id. With `{ chain: true }`, dereference
	 * that id as a reference (when the deployment stores per-name reference ids).
	 */
	async resolve(name: string, opts: { namespace?: string; chain?: boolean } = {}): Promise<unknown> {
		const entry = await this.lookup(name, { namespace: opts.namespace });
		if (!entry) return null;
		return opts.chain ? this.resolveReference(entry.id) : entry.id;
	}

	/**
	 * Directory names whose entry id is a reference@1.0 init committed by `address`
	 * (the per-name-reference model). Empty when entries are plain content targets.
	 */
	async namesByOwner(address: string, opts: { namespace?: string } = {}): Promise<DirectoryEntry[]> {
		const owned = new Set(await discoverInitsByOwner({ endpoint: this.graphql, fetch: this.fetchImpl, owner: address }));
		const dir = await this.getDirectory({ namespace: opts.namespace });
		const out: DirectoryEntry[] = [];
		for (const [name, entry] of Object.entries(dir.paths)) {
			if (owned.has(entry.id)) out.push({ name, id: entry.id });
		}
		return out;
	}

	// --- write (§3, §4) ---

	private requireSigner(): Signer {
		if (!this.signer) throw new Error('No signer configured; pass { signer } (fromWallet / fromJwk) to write');
		return this.signer;
	}

	/** Mint a new reference (an `init`). The data-item id is the reference id (§2). */
	async createReference(opts: { value?: string; authority?: string; timestamp?: number } = {}): Promise<{ referenceId: string }> {
		const signer = this.requireSigner();
		const { tags } = buildInit({ value: opts.value, authority: opts.authority, timestamp: opts.timestamp ?? Date.now() });
		const { id } = await signer.send({ tags, data: ' ' });
		return { referenceId: id };
	}

	/** Update a reference's value (a `set`); the connected signer must be its authority. */
	async setReference(referenceId: string, opts: { value?: string; timestamp?: number } = {}): Promise<{ id: string }> {
		const signer = this.requireSigner();
		const { tags } = buildSet({ referenceId, value: opts.value, timestamp: opts.timestamp ?? Date.now() });
		return signer.send({ tags, data: ' ' });
	}

	/**
	 * Mint a downstream reference for `name` and return it plus the directory pointer.
	 * Adding the pointer to the global directory is the namespace authority's step
	 * (`updateDirectory`), so registration is request-then-publish unless you hold it.
	 */
	async registerName(name: string, opts: { value?: string } = {}): Promise<{ name: string; referenceId: string; pointer: ReferenceMessage }> {
		const { referenceId } = await this.createReference({ value: opts.value });
		return { name, referenceId, pointer: buildPointer(referenceId) };
	}

	/**
	 * Republish the namespace directory as a manifest and point the namespace
	 * reference at it (a total snapshot, §9). Operator op: the signer must be the
	 * namespace authority.
	 */
	async updateDirectory(paths: Record<string, { id: string }>, opts: { namespace?: string } = {}): Promise<{ manifestId: string; setId: string }> {
		const signer = this.requireSigner();
		const ns = this.requireNamespace(opts.namespace);
		const manifest = JSON.stringify({ manifest: 'arweave/paths', version: '0.2.0', index: {}, paths });
		const up = await signer.send({
			tags: [
				{ name: 'content-type', value: 'application/x.arweave-manifest+json' },
				{ name: 'device', value: 'manifest@1.0' },
			],
			data: manifest,
		});
		const set = await this.setReference(ns, { value: up.id });
		return { manifestId: up.id, setId: set.id };
	}
}

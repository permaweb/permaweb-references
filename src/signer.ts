import type { Tag } from './types.js';

/** Signs and uploads committed reference messages. */
export interface Signer {
	/** The signer's address (becomes the authority for `init`s). */
	address(): Promise<string>;
	/** Sign + upload a committed message; returns the resulting data-item id. */
	send(message: { tags: Tag[]; data?: string }): Promise<{ id: string }>;
}

// Lazy-load optional peers so read-only consumers never need them, and tsc does
// not require their types (variable specifier => not statically resolved).
async function loadModule(name: string): Promise<any> {
	try {
		return await import(/* @vite-ignore */ name);
	} catch {
		throw new Error(`This signer needs '${name}' installed (npm i ${name})`);
	}
}
async function loadDefault(name: string): Promise<any> {
	const mod = await loadModule(name);
	return mod.default ?? mod;
}

/**
 * Browser wallet signer (e.g. `window.arweaveWallet`): builds an Arweave tx and
 * dispatches it; the wallet handles bundling/upload. Needs `arweave` available.
 */
export function fromWallet(wallet: any, opts: { host?: string } = {}): Signer {
	const host = opts.host ?? 'arweave.net';
	return {
		async address() {
			return wallet.getActiveAddress();
		},
		async send({ tags, data }) {
			const Arweave = await loadDefault('arweave');
			const arweave = Arweave.init({ host, port: 443, protocol: 'https' });
			// arweave rejects empty data; reference-value rides in a tag.
			const tx = await arweave.createTransaction({ data: data && data.length ? data : ' ' });
			for (const t of tags) tx.addTag(t.name, t.value);
			const res = await wallet.dispatch(tx);
			return { id: res.id };
		},
	};
}

/**
 * JWK signer: signs an ANS-104 data item and POSTs it to the bundler (no Turbo
 * SDK). Default bundler is set by the client; override per deployment. Needs
 * `arbundles` available.
 */
export function fromJwk(jwk: any, opts: { bundler: string; fetch?: typeof fetch; host?: string }): Signer {
	const host = opts.host ?? 'arweave.net';
	return {
		async address() {
			const Arweave = await loadDefault('arweave');
			return Arweave.init({ host, port: 443, protocol: 'https' }).wallets.jwkToAddress(jwk);
		},
		async send({ tags, data }) {
			const arbundles = await loadModule('arbundles');
			const signer = new arbundles.ArweaveSigner(jwk);
			const item = arbundles.createData(data ?? '', signer, { tags });
			await item.sign(signer);
			const f = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined);
			if (!f) throw new Error('No fetch available for bundler upload');
			const res = await f(`${opts.bundler.replace(/\/+$/, '')}/tx`, {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: item.getRaw(),
			});
			if (!res.ok) throw new Error(`bundler upload failed: ${res.status} ${res.statusText}`);
			return { id: item.id };
		},
	};
}

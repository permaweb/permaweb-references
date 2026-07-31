import type { Tag } from './types.js';
import { bundlerDataItemEndpoint, transactionEndpoint } from './endpoints.js';

export interface SendOptions {
	bundler?: string;
	fetch?: typeof fetch;
}

export interface SendTransactionOptions {
	gateway?: string;
	fetch?: typeof fetch;
	expectedSigner?: string;
}

export interface TransactionMessage {
	target: string;
	quantity?: string;
	rewardFloor?: string;
	tags: Tag[];
	data?: string;
}

export interface SignedTransaction {
	id: string;
	transaction: unknown;
}

/** Signs and uploads committed reference messages. */
export interface Signer {
	/** The signer's address (becomes the authority for `init`s). */
	address(): Promise<string>;
	/** Sign + upload a committed message; returns the resulting data-item id. */
	send(message: { tags: Tag[]; data?: string }, opts?: SendOptions): Promise<{ id: string }>;
	/** Sign a data-free layer-1 Arweave transaction, without uploading it. */
	signTransaction?(message: TransactionMessage, opts?: SendTransactionOptions): Promise<SignedTransaction>;
	/** Upload a previously signed layer-1 Arweave transaction. */
	postTransaction?(signed: SignedTransaction, opts?: SendTransactionOptions): Promise<{ id: string }>;
	/** Sign + upload a data-free layer-1 Arweave transaction. */
	sendTransaction?(message: TransactionMessage, opts?: SendTransactionOptions): Promise<{ id: string }>;
	/** Sign every transaction first, then upload them in order. */
	sendTransactions?(messages: TransactionMessage[], opts?: SendTransactionOptions): Promise<Array<{ id: string }>>;
}

const DEFAULT_BUNDLER = 'https://up.arweave.net';
const DEFAULT_GATEWAY = 'https://arweave.net';

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
 * Browser wallet signer (e.g. `window.arweaveWallet`): reference data-items use
 * wallet dispatch; carrier process transactions use wallet signing plus gateway
 * upload so the signed layer-1 transaction can be checked before broadcast.
 */
export function fromWallet(wallet: any, opts: { host?: string; gateway?: string; fetch?: typeof fetch } = {}): Signer {
	const host = opts.host ?? 'arweave.net';
	const signer: Signer = {
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
		async signTransaction(message, sendOpts = {}) {
			if (typeof wallet.sign !== 'function') {
				throw new Error('wallet.sign is required for carrier process transactions');
			}
			const Arweave = await loadDefault('arweave');
			const arweave = Arweave.init({ host, port: 443, protocol: 'https' });
			await assertExpectedActiveAddress(wallet, sendOpts.expectedSigner);
			const tx = await buildArweaveTransaction(arweave, message);
			const signed = await wallet.sign(tx);
			const signedTx = signed ?? tx;
			assertDataFreeTransaction(signedTx);
			await assertTransactionOwner(arweave, signedTx, sendOpts.expectedSigner);
			const id = textField(signedTx, 'id');
			if (!id) throw new Error('wallet did not return a signed transaction id');
			return { id, transaction: signedTx };
		},
		async postTransaction(signed, sendOpts = {}) {
			await postSignedTransaction(signed, {
				gateway: sendOpts.gateway ?? opts.gateway ?? DEFAULT_GATEWAY,
				fetch: sendOpts.fetch ?? opts.fetch,
			});
			return { id: signed.id };
		},
	};
	signer.sendTransaction = async (message, sendOpts = {}) => {
		const signed = await signer.signTransaction!(message, sendOpts);
		return signer.postTransaction!(signed, sendOpts);
	};
	signer.sendTransactions = async (messages, sendOpts = {}) => {
		const signed: SignedTransaction[] = [];
		for (const message of messages) signed.push(await signer.signTransaction!(message, sendOpts));
		const posted: Array<{ id: string }> = [];
		for (const transaction of signed) posted.push(await signer.postTransaction!(transaction, sendOpts));
		return posted;
	};
	return signer;
}

/**
 * JWK signer: signs an ANS-104 data item and POSTs it to the bundler (no Turbo
 * SDK). Default bundler is set by the client; override per deployment. Needs
 * `arbundles` available.
 */
export function fromJwk(jwk: any, opts: { bundler?: string; fetch?: typeof fetch; host?: string } = {}): Signer {
	const host = opts.host ?? 'arweave.net';
	const signer: Signer = {
		async address() {
			const Arweave = await loadDefault('arweave');
			return Arweave.init({ host, port: 443, protocol: 'https' }).wallets.jwkToAddress(jwk);
		},
		async send({ tags, data }, sendOpts = {}) {
			const arbundles = await loadModule('arbundles');
			const signer = new arbundles.ArweaveSigner(jwk);
			const item = arbundles.createData(data ?? '', signer, { tags });
			await item.sign(signer);
			const f = sendOpts.fetch ?? opts.fetch ?? (globalThis.fetch as typeof fetch | undefined);
			if (!f) throw new Error('No fetch available for bundler upload');
			const res = await f(bundlerDataItemEndpoint(sendOpts.bundler ?? opts.bundler ?? DEFAULT_BUNDLER), {
				method: 'POST',
				headers: {
					accept: 'application/json, text/plain, */*',
					'content-type': 'application/octet-stream',
				},
				body: item.getRaw(),
			});
			if (!res.ok) {
				const details = res.headers.get('details');
				throw new Error(`bundler upload failed: ${res.status} ${res.statusText}${details ? ` (${details})` : ''}`);
			}
			return { id: item.id };
		},
		async signTransaction(message, sendOpts = {}) {
			const Arweave = await loadDefault('arweave');
			const arweave = Arweave.init({ host, port: 443, protocol: 'https' });
			const tx = await buildArweaveTransaction(arweave, message, jwk);
			await arweave.transactions.sign(tx, jwk);
			assertDataFreeTransaction(tx);
			await assertTransactionOwner(arweave, tx, sendOpts.expectedSigner);
			const id = textField(tx, 'id');
			if (!id) throw new Error('jwk signer did not produce a transaction id');
			return { id, transaction: tx };
		},
		async postTransaction(signed, sendOpts = {}) {
			await postSignedTransaction(signed, {
				gateway: sendOpts.gateway ?? DEFAULT_GATEWAY,
				fetch: sendOpts.fetch ?? opts.fetch,
			});
			return { id: signed.id };
		},
	};
	signer.sendTransaction = async (message, sendOpts = {}) => {
		const signed = await signer.signTransaction!(message, sendOpts);
		return signer.postTransaction!(signed, sendOpts);
	};
	signer.sendTransactions = async (messages, sendOpts = {}) => {
		const signed: SignedTransaction[] = [];
		for (const message of messages) signed.push(await signer.signTransaction!(message, sendOpts));
		const posted: Array<{ id: string }> = [];
		for (const transaction of signed) posted.push(await signer.postTransaction!(transaction, sendOpts));
		return posted;
	};
	return signer;
}

async function buildArweaveTransaction(arweave: any, message: TransactionMessage, jwk?: any): Promise<any> {
	if (message.data && message.data.length > 0) throw new Error('carrier process transactions must not contain data');
	const fields: Record<string, string> = {};
	if (message.target) fields.target = message.target;
	if (message.quantity !== undefined) fields.quantity = message.quantity;
	const tx = await arweave.createTransaction(fields, jwk);
	if (message.rewardFloor !== undefined && BigInt(textField(tx, 'reward') || '0') < BigInt(message.rewardFloor)) {
		tx.reward = message.rewardFloor;
	}
	for (const tag of message.tags) tx.addTag(tag.name, tag.value);
	return tx;
}

async function postSignedTransaction(
	signed: SignedTransaction,
	options: { gateway: string; fetch?: typeof fetch }
): Promise<void> {
	const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
	if (!f) throw new Error('No fetch available for transaction upload');
	const res = await f(transactionEndpoint(options.gateway), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(signed.transaction),
	});
	if (!res.ok && res.status !== 208) throw new Error(`transaction upload failed: ${res.status} ${res.statusText}`);
}

async function assertExpectedActiveAddress(wallet: any, expected: string | undefined): Promise<void> {
	if (!expected) return;
	if (typeof wallet.getActiveAddress !== 'function') throw new Error('wallet active address is unavailable');
	const active = await wallet.getActiveAddress();
	if (active !== expected) throw new Error(`wallet active address mismatch: expected ${expected}, got ${active}`);
}

async function assertTransactionOwner(arweave: any, tx: unknown, expected: string | undefined): Promise<void> {
	if (!expected) return;
	const owner = textField(tx, 'owner');
	if (!owner) throw new Error('signed transaction owner is unavailable');
	const address = await arweave.wallets.ownerToAddress(owner);
	if (address !== expected) throw new Error(`signed transaction owner mismatch: expected ${expected}, got ${address}`);
}

function assertDataFreeTransaction(tx: unknown): void {
	const dataSize = textField(tx, 'data_size');
	if (dataSize && BigInt(dataSize) !== 0n) throw new Error('carrier process transaction contains data');
	const dataRoot = textField(tx, 'data_root');
	if (dataRoot) throw new Error('carrier process transaction contains data');
	const data = (tx as { data?: unknown } | null)?.data;
	if (typeof data === 'string' && data.length > 0) throw new Error('carrier process transaction contains data');
	if (data instanceof Uint8Array && data.byteLength > 0) throw new Error('carrier process transaction contains data');
	if (Array.isArray(data) && data.length > 0) throw new Error('carrier process transaction contains data');
}

function textField(value: unknown, key: string): string {
	if (!value || typeof value !== 'object') return '';
	const held = (value as Record<string, unknown>)[key];
	return typeof held === 'string' ? held : '';
}

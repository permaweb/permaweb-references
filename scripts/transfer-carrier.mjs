#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
	ReferenceClient,
	carrierTarget,
	fromJwk,
	isArweaveId,
	ownerOfCarrier,
	readCarrierState,
	waitForCarrierState,
} from '../dist/index.js';

const DEFAULT_GATEWAY = 'https://arweave.net';
const DEFAULT_NODE = 'https://arweave.net';
const DEFAULT_BUNDLER = 'http://localhost:8734/tx~bundler@1.0?codec-device=ans104@1.0&accept=json@1.0';

const usage = `Create or reuse a reference, point a carrier at it, then transfer the carrier to the reference wallet.

Usage:
  npm run transfer-carrier -- \\
    --reference-wallet /path/to/new-wallet.json \\
    --carrier-wallet /path/to/carrier-owner-wallet.json \\
    --carrier-name <name>

Options:
      --reference-wallet <path>  JWK that creates and controls the new reference
      --carrier-wallet <path>    JWK that currently owns the carrier
  -n, --carrier-name <name>      Resolve a carrier process from its namespace name
  -c, --carrier <id>             Carrier process id (alternative to --carrier-name)
  -r, --reference <id>           Reuse an existing reference (for resuming a timed-out run)
      --transfer-transaction <id> Reuse a posted transfer and only wait for carrier state
  -v, --value <value>            Initial reference value (default: current carrier target)
      --gateway <url>            Arweave gateway (default: ${DEFAULT_GATEWAY})
      --node <url>               HyperBEAM node (default: ${DEFAULT_NODE})
      --bundler <url>            ANS-104 bundler (default: ${DEFAULT_BUNDLER})
  -d, --dry-run                  Resolve and validate inputs without writing
  -h, --help                     Show this help
`;

function required(values, name) {
	const value = values[name];
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError(`missing required option: --${name}`);
	}
	return value;
}

async function loadJwk(path) {
	let jwk;
	try {
		jwk = JSON.parse(await readFile(resolve(path), 'utf8'));
	} catch (error) {
		throw new Error(`could not read wallet JWK at ${path}`, { cause: error });
	}
	if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) {
		throw new TypeError(`wallet JWK at ${path} is not a JSON object`);
	}
	return jwk;
}

function carrierStateLogger({ carrierId, expectedTarget, expectedOwner, phase }) {
	let fetchNumber = 0;
	return ({ provider, path, status, state, error }) => {
		fetchNumber += 1;
		if (state) {
			const target = carrierTarget(state.value);
			const owner = ownerOfCarrier(state);
			console.log(JSON.stringify({
				status: 'carrier-state-fetched',
				phase,
				fetch: fetchNumber,
				carrierId,
				provider,
				path,
				httpStatus: status,
				target,
				expectedTarget,
				targetMatches: target === expectedTarget,
				owner,
				expectedOwner,
				ownerMatches: owner === expectedOwner,
				state: {
					device: state.device,
					name: state.name,
					totalSupply: state.totalSupply,
					balances: state.balances,
					swapHeight: state.swapHeight,
					value: state.value,
				},
			}, null, 2));
			return;
		}

		console.log(JSON.stringify({
			status: 'carrier-state-fetch-failed',
			phase,
			fetch: fetchNumber,
			carrierId,
			provider,
			path,
			httpStatus: status,
			error: error instanceof Error ? error.message : String(error),
		}, null, 2));
	};
}

export async function createReferenceAndUpdateCarrier({
	referenceWalletPath,
	carrierWalletPath,
	carrierId,
	carrierName,
	referenceId,
	existingTransferTransactionId,
	value,
	gateway = DEFAULT_GATEWAY,
	node = DEFAULT_NODE,
	bundler = DEFAULT_BUNDLER,
	dryRun = false,
}) {
	if (carrierId && carrierName) throw new TypeError('pass either --carrier or --carrier-name, not both');
	if (!carrierId && !carrierName) throw new TypeError('missing required option: --carrier-name or --carrier');
	if (carrierId && !isArweaveId(carrierId)) throw new TypeError('invalid carrier process id');
	if (referenceId && !isArweaveId(referenceId)) throw new TypeError('invalid existing reference id');
	if (existingTransferTransactionId && !isArweaveId(existingTransferTransactionId)) {
		throw new TypeError('invalid existing carrier transfer transaction id');
	}
	if (existingTransferTransactionId && !referenceId) {
		throw new TypeError('--transfer-transaction requires --reference');
	}
	if (carrierName) {
		const lookupClient = new ReferenceClient({ gateway, node });
		const record = await lookupClient.getName(carrierName);
		if (!record) throw new Error(`carrier name not found: ${carrierName}`);
		if (record.kind !== 'carrier' || !record.processId) {
			throw new Error(`name is not backed by a carrier process: ${carrierName}`);
		}
		carrierId = record.processId;
	}

	const [referenceJwk, carrierJwk] = await Promise.all([
		loadJwk(referenceWalletPath),
		loadJwk(carrierWalletPath),
	]);
	const referenceSigner = fromJwk(referenceJwk, { bundler });
	const carrierSigner = fromJwk(carrierJwk);
	const [referenceAuthority, carrierOwner] = await Promise.all([
		referenceSigner.address(),
		carrierSigner.address(),
	]);
	const { state } = await readCarrierState(carrierId, { provider: node, fetch: globalThis.fetch });
	const currentCarrierTarget = carrierTarget(state.value);
	const alreadyTransferred = Boolean(
		referenceId &&
		currentCarrierTarget === referenceId &&
		state.balances[referenceAuthority] === '1'
	);
	if (existingTransferTransactionId && currentCarrierTarget !== referenceId) {
		throw new Error(
			`carrier ${carrierId} does not yet point to reference ${referenceId}; refusing to reuse transfer transaction ${existingTransferTransactionId}`,
		);
	}
	if (state.balances[carrierOwner] !== '1' && !alreadyTransferred) {
		throw new Error(`wallet ${carrierOwner} is not the holder of carrier ${carrierId}`);
	}
	const referenceValue = value ?? currentCarrierTarget;
	if (!referenceId && (typeof referenceValue !== 'string' || referenceValue.length === 0)) {
		throw new Error('carrier has no current target; pass --value explicitly');
	}
	if (dryRun) {
		const actions = [];
		if (!referenceId) {
			actions.push({
				action: 'create-reference',
				signer: referenceAuthority,
				value: referenceValue,
			});
		}
		if (!alreadyTransferred && (!referenceId || currentCarrierTarget !== referenceId)) {
			actions.push({
				action: 'set-carrier-target',
				signer: carrierOwner,
				carrierId,
				target: referenceId ?? '<new-reference-id>',
			});
		}
		if (!alreadyTransferred && existingTransferTransactionId) {
			actions.push({
				action: 'wait-for-carrier-transfer',
				carrierId,
				referenceId,
				transactionId: existingTransferTransactionId,
				recipient: referenceAuthority,
			});
		} else if (!alreadyTransferred) {
			actions.push({
				action: 'transfer-carrier',
				signer: carrierOwner,
				carrierId,
				recipient: referenceAuthority,
			});
		}
		return {
			dryRun: true,
			carrierId,
			carrierName,
			carrierOwner,
			referenceAuthority,
			referenceValue,
			referenceId,
			actions,
		};
	}

	const referenceClient = new ReferenceClient({ gateway, bundler, signer: referenceSigner });
	const carrierClient = new ReferenceClient({ gateway, node, signer: carrierSigner });
	if (referenceId) {
		const existing = await referenceClient.getReference(referenceId);
		if (existing?.authority && existing.authority !== referenceAuthority) {
			throw new Error(`wallet ${referenceAuthority} is not the authority of reference ${referenceId}`);
		}
		console.log(JSON.stringify({ referenceId, referenceAuthority, carrierId, carrierName, status: 'reference-reused' }, null, 2));
	} else {
		({ referenceId } = await referenceClient.createReference({ value: referenceValue }));
		console.log(JSON.stringify({ referenceId, referenceAuthority, carrierId, carrierName, status: 'reference-created' }, null, 2));
	}
	if (alreadyTransferred) {
		console.log(JSON.stringify({ carrierId, referenceId, carrierOwner: referenceAuthority, status: 'carrier-already-transferred' }, null, 2));
		return {
			referenceId,
			referenceAuthority,
			carrierId,
			carrierName,
			previousCarrierOwner: carrierOwner,
			carrierOwner: referenceAuthority,
			alreadyTransferred: true,
		};
	}

	let carrierTargetTransactionId;
	if (currentCarrierTarget === referenceId) {
		console.log(JSON.stringify({ carrierId, referenceId, status: 'carrier-target-already-set' }, null, 2));
	} else {
		try {
			({ id: carrierTargetTransactionId } = await carrierClient.setCarrierTarget(carrierId, referenceId));
			console.log(JSON.stringify({ carrierId, carrierTargetTransactionId, status: 'carrier-target-transaction-posted' }, null, 2));
		} catch (error) {
			throw new Error(
				`reference ${referenceId} is ready, but carrier ${carrierId} was not updated`,
				{ cause: error },
			);
		}

		console.log(JSON.stringify({ carrierId, referenceId, carrierTargetTransactionId, status: 'waiting-for-carrier-target' }, null, 2));
		try {
			await waitForCarrierState(
				carrierId,
				(state) => carrierTarget(state.value) === referenceId && state.balances[carrierOwner] === '1',
				{
					provider: node,
					fetch: globalThis.fetch,
					onRead: carrierStateLogger({
						carrierId,
						expectedTarget: referenceId,
						expectedOwner: carrierOwner,
						phase: 'target-update',
					}),
				},
			);
		} catch (error) {
			throw new Error(
				`carrier target transaction ${carrierTargetTransactionId} was posted, but carrier ${carrierId} did not reach target ${referenceId}; transfer was not attempted`,
				{ cause: error },
			);
		}
	}

	let carrierTransferTransactionId = existingTransferTransactionId;
	if (carrierTransferTransactionId) {
		console.log(JSON.stringify({ carrierId, referenceId, carrierTransferTransactionId, status: 'carrier-transfer-transaction-reused' }, null, 2));
	} else {
		try {
			({ id: carrierTransferTransactionId } = await carrierClient.transferCarrier(carrierId, referenceAuthority));
			console.log(JSON.stringify({ carrierId, referenceId, carrierTransferTransactionId, status: 'carrier-transfer-transaction-posted' }, null, 2));
		} catch (error) {
			throw new Error(
				`carrier ${carrierId} points to reference ${referenceId}, but was not transferred to ${referenceAuthority}`,
				{ cause: error },
			);
		}
	}

	console.log(JSON.stringify({ carrierId, referenceId, carrierTransferTransactionId, status: 'waiting-for-carrier-owner' }, null, 2));
	try {
		await waitForCarrierState(
			carrierId,
			(state) => carrierTarget(state.value) === referenceId && state.balances[referenceAuthority] === '1',
			{
				provider: node,
				fetch: globalThis.fetch,
				onRead: carrierStateLogger({
					carrierId,
					expectedTarget: referenceId,
					expectedOwner: referenceAuthority,
					phase: 'owner-transfer',
				}),
			},
		);
	} catch (error) {
		throw new Error(
			`carrier transfer transaction ${carrierTransferTransactionId} was posted, but carrier ${carrierId} did not reach owner ${referenceAuthority}`,
			{ cause: error },
		);
	}

	return {
		referenceId,
		referenceAuthority,
		carrierId,
		carrierName,
		previousCarrierOwner: carrierOwner,
		carrierOwner: referenceAuthority,
		carrierTargetTransactionId,
		carrierTransferTransactionId,
	};
}

async function main() {
	const { values } = parseArgs({
		options: {
			'reference-wallet': { type: 'string' },
			'carrier-wallet': { type: 'string' },
			'carrier-name': { type: 'string', short: 'n' },
			carrier: { type: 'string', short: 'c' },
			reference: { type: 'string', short: 'r' },
			'transfer-transaction': { type: 'string' },
			value: { type: 'string', short: 'v' },
			gateway: { type: 'string', default: DEFAULT_GATEWAY },
			node: { type: 'string', default: DEFAULT_NODE },
			bundler: { type: 'string', default: DEFAULT_BUNDLER },
			'dry-run': { type: 'boolean', short: 'd', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
		strict: true,
	});

	if (values.help) {
		console.log(usage);
		return;
	}

	const result = await createReferenceAndUpdateCarrier({
		referenceWalletPath: required(values, 'reference-wallet'),
		carrierWalletPath: required(values, 'carrier-wallet'),
		carrierId: values.carrier,
		carrierName: values['carrier-name'],
		referenceId: values.reference,
		existingTransferTransactionId: values['transfer-transaction'],
		value: values.value,
		gateway: values.gateway,
		node: values.node,
		bundler: values.bundler,
		dryRun: values['dry-run'],
	});
	console.log(JSON.stringify({ ...result, status: values['dry-run'] ? 'dry-run' : 'carrier-transferred' }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

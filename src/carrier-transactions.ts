import type { SwapOrder } from './names.js';
import { isArweaveId } from './names.js';
import type { TransactionMessage } from './signer.js';

export const DEFAULT_CARRIER_REGISTRATION_FEE = 100_000_000n;
export const MAXIMUM_CARRIER_REGISTRATION_FEE = 10_000_000_000n;
export const MAXIMUM_CARRIER_OFFER_PRICE = 66_000_000_000_000_000_000n;
export const DEFAULT_CARRIER_OFFER_BLOCKS = 21_600;
export const DEFAULT_CARRIER_RESERVATION_INCLUSION_MARGIN = 2;

export type AmountLike = string | number | bigint;

export interface CarrierMakeOfferOptions {
	asking: AmountLike;
	currentHeight: number;
	minimumFee?: AmountLike;
	deadline?: number;
}

export function buildCarrierSetTarget(processId: string, target: string): TransactionMessage {
	assertArweaveId(processId, 'invalid-carrier-process-id');
	assertArweaveId(target, 'invalid-carrier-target-id');
	return {
		target: processId,
		quantity: '1',
		tags: [
			{ name: 'action', value: 'set' },
			{ name: 'reference-value', value: target },
		],
	};
}

export function buildCarrierTransfer(processId: string, recipient: string): TransactionMessage {
	assertArweaveId(processId, 'invalid-carrier-process-id');
	assertArweaveId(recipient, 'invalid-carrier-recipient');
	return {
		target: processId,
		quantity: '1',
		tags: [
			{ name: 'action', value: 'transfer' },
			{ name: 'recipient', value: recipient },
			{ name: 'quantity', value: '1' },
		],
	};
}

export function buildCarrierMakeOffer(processId: string, opts: CarrierMakeOfferOptions): TransactionMessage {
	assertArweaveId(processId, 'invalid-carrier-process-id');
	if (!Number.isSafeInteger(opts.currentHeight) || opts.currentHeight < 0) throw new TypeError('invalid-current-height');
	const asking = normalizeAmount(opts.asking, {
		name: 'asking',
		positive: true,
		maximum: MAXIMUM_CARRIER_OFFER_PRICE,
	});
	const minimumFee = normalizeAmount(opts.minimumFee ?? DEFAULT_CARRIER_REGISTRATION_FEE, {
		name: 'minimum-fee',
		positive: false,
		maximum: MAXIMUM_CARRIER_REGISTRATION_FEE,
	});
	const deadline = opts.deadline ?? opts.currentHeight + DEFAULT_CARRIER_OFFER_BLOCKS;
	if (!Number.isSafeInteger(deadline) || deadline <= opts.currentHeight) throw new TypeError('invalid-carrier-offer-deadline');

	return {
		target: processId,
		quantity: '1',
		tags: [
			{ name: 'action', value: 'make-offer' },
			{ name: 'offer-quantity', value: '1' },
			{ name: 'asking', value: asking },
			{ name: 'deposit', value: '0' },
			{ name: 'minimum-fee', value: minimumFee },
			{ name: 'deadline', value: String(deadline) },
		],
	};
}

export function buildCarrierCancelOrder(processId: string, orderId: string): TransactionMessage {
	assertArweaveId(processId, 'invalid-carrier-process-id');
	assertArweaveId(orderId, 'invalid-carrier-order-id');
	return {
		target: processId,
		quantity: '1',
		tags: [
			{ name: 'action', value: 'cancel-order' },
			{ name: 'order-id', value: orderId },
		],
	};
}

export function buildCarrierRegisterInterest(processId: string, order: SwapOrder): TransactionMessage {
	assertArweaveId(processId, 'invalid-carrier-process-id');
	assertSafeCarrierPurchaseOrder(order);
	return {
		target: processId,
		quantity: '0',
		rewardFloor: order.minimumFee,
		tags: [
			{ name: 'action', value: 'register-interest' },
			{ name: 'order-id', value: order.orderId },
		],
	};
}

export function buildCarrierPayment(order: SwapOrder): TransactionMessage {
	assertSafeCarrierPurchaseOrder(order);
	return {
		target: order.recipient,
		quantity: order.asking,
		tags: [{ name: 'order-id', value: order.orderId }],
	};
}

export function carrierPurchaseOrderSafetyError(order: SwapOrder): string | null {
	if (!isArweaveId(order.orderId)) return 'invalid-carrier-order-id';
	if (!isArweaveId(order.creator)) return 'invalid-carrier-order-creator';
	if (!isArweaveId(order.recipient)) return 'invalid-carrier-order-recipient';
	if (order.quantity !== 1) return 'invalid-carrier-order-quantity';
	if (!isPositiveAmount(order.asking)) return 'invalid-carrier-order-asking';
	if (!isUnsignedAmount(order.minimumFee)) return 'invalid-carrier-order-minimum-fee';
	if (BigInt(order.asking) > MAXIMUM_CARRIER_OFFER_PRICE) return 'carrier-order-asking-too-large';
	if (BigInt(order.minimumFee) > MAXIMUM_CARRIER_REGISTRATION_FEE) return 'carrier-order-minimum-fee-too-large';
	if (!Number.isSafeInteger(order.deadline) || order.deadline < 0) return 'invalid-carrier-order-deadline';
	return null;
}

export function assertSafeCarrierPurchaseOrder(order: SwapOrder): void {
	const error = carrierPurchaseOrderSafetyError(order);
	if (error) throw new TypeError(error);
}

function assertArweaveId(value: string, message: string): void {
	if (!isArweaveId(value)) throw new TypeError(message);
}

function normalizeAmount(
	value: AmountLike,
	options: {
		name: string;
		positive: boolean;
		maximum: bigint;
	}
): string {
	const normalized = amountText(value);
	const valid = options.positive ? isPositiveAmount(normalized) : isUnsignedAmount(normalized);
	if (!valid) throw new TypeError(`invalid-carrier-${options.name}`);
	if (BigInt(normalized) > options.maximum) throw new RangeError(`carrier-${options.name}-too-large`);
	return normalized;
}

function amountText(value: AmountLike): string {
	if (typeof value === 'bigint') return value >= 0n ? value.toString() : '';
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
	return value;
}

function isPositiveAmount(value: string): boolean {
	return /^[1-9]\d*$/.test(value);
}

function isUnsignedAmount(value: string): boolean {
	return /^(?:0|[1-9]\d*)$/.test(value);
}

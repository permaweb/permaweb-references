import type { Address, ReferenceMessage, Tag } from './types.js';

export const DEVICE = 'reference@1.0';

export interface BuildInitOptions {
	value?: string;
	authority?: Address;
	timestamp?: number;
}

export interface BuildSetOptions {
	referenceId: string;
	value?: string;
	timestamp: number;
}

/** An `init` (§3): creates a reference; MUST NOT carry `reference-id` (§2). */
export function buildInit(opts: BuildInitOptions = {}): { message: ReferenceMessage; tags: Tag[] } {
	const message: ReferenceMessage = { device: DEVICE };
	if (opts.authority) message.authority = opts.authority;
	if (opts.timestamp !== undefined) message.timestamp = opts.timestamp;
	if (opts.value !== undefined) message['reference-value'] = opts.value;
	return { message, tags: toTags(message) };
}

/** A `set` (§3): updates a reference; `reference-id` and `timestamp` are required. */
export function buildSet(opts: BuildSetOptions): { message: ReferenceMessage; tags: Tag[] } {
	const message: ReferenceMessage = {
		device: DEVICE,
		'reference-id': opts.referenceId,
		timestamp: opts.timestamp,
	};
	if (opts.value !== undefined) message['reference-value'] = opts.value;
	return { message, tags: toTags(message) };
}

/** The minimal downstream-reference handle stored in a directory (§9). */
export function buildPointer(referenceId: string): ReferenceMessage {
	return { device: DEVICE, 'reference-id': referenceId };
}

/**
 * Encode scalar message keys as ANS-104 tags (the common case: ids + timestamp).
 * Nested-message `reference-value`s need the AO data-item codec, which arrives
 * with the signer in a later phase.
 */
export function toTags(message: ReferenceMessage): Tag[] {
	const tags: Tag[] = [];
	for (const [name, value] of Object.entries(message)) {
		if (value === undefined || value === null) continue;
		if (typeof value === 'object') continue;
		tags.push({ name, value: String(value) });
	}
	return tags;
}

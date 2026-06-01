export type Address = string;

/** A `reference@1.0` message body (§3). Keys are binary/string in AO-Core. */
export interface ReferenceMessage {
	device?: string;
	'reference-id'?: string;
	'reference-value'?: unknown;
	timestamp?: number | string;
	authority?: Address;
	[key: string]: unknown;
}

export interface Tag {
	name: string;
	value: string;
}

/**
 * A discovered `set` plus the commitment/position metadata needed to apply §4:
 * who committed it (`committers`) and its data-layer position (for tie-breaking).
 */
export interface Candidate {
	message: ReferenceMessage;
	committers: Address[];
	position: { block: number; index: number };
	id?: string;
}

export interface ResolvedState {
	message: ReferenceMessage;
	timestamp: number;
	source: 'init' | 'set';
}

export interface ResolvedReference {
	id: string;
	authority?: Address;
	value: unknown;
	timestamp: number;
	source: 'init' | 'set';
}

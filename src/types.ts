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

export type NameKind = 'reference' | 'name-token';

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

/** A namespace name resolved to its current reference state. */
export interface ResolvedName {
	name: string;
	referenceId: string;
	namespaceId?: string;
	processId?: string;
	authority?: Address;
	value: unknown;
	timestamp?: number;
	source?: 'init' | 'set' | 'process';
	kind?: NameKind;
	tokenState?: unknown;
}

/** A reference controlled by a wallet, as returned by `findReferences`. */
export interface OwnedReference {
	referenceId: string;
	/** Human name from the namespace, or null if the reference is not in it. */
	name: string | null;
	/** The reference's recorded value (its `reference-value`); resolve for the latest if it has updates. */
	value: unknown;
	nameSource?: string;
	dateRegistered?: string;
}

/** A wallet-owned name in the mainnet namespace, legacy or tokenized. */
export interface OwnedName {
	name: string;
	referenceId: string;
	namespaceId: string;
	authority?: Address;
	value: unknown;
	kind: NameKind;
	processId?: string;
	timestamp?: number;
	source?: 'init' | 'set' | 'process';
	tokenState?: unknown;
}

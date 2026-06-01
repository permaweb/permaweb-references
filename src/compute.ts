import type { Address, Candidate, ReferenceMessage, ResolvedState } from './types.js';

export function timestampOf(message: ReferenceMessage): number {
	const t = message.timestamp;
	if (t === undefined || t === null || t === '') return 0;
	const n = Number(t);
	return Number.isFinite(n) ? n : 0;
}

/** The effective value of a message: its `reference-value` if present, else itself (§3). */
export function effectiveValue(message: ReferenceMessage): unknown {
	const v = message['reference-value'];
	return v !== undefined ? v : message;
}

/** Ascending data-layer order: block height, then position within the block (§4). */
function comparePosition(a: Candidate, b: Candidate): number {
	if (a.position.block !== b.position.block) return a.position.block - b.position.block;
	return a.position.index - b.position.index;
}

/**
 * Fold candidate `set`s over the `init` to the current state (§4): a set applies
 * only if (1) committed by the authority and (2) strictly newer than the current
 * state. Folding in ascending data-layer order makes equal timestamps resolve to
 * the earliest position (later equals are not strictly greater, so ignored).
 */
export function currentState(args: {
	init: ReferenceMessage;
	authority: Address | undefined;
	candidates: Candidate[];
}): ResolvedState {
	const { init, authority, candidates } = args;
	let state: ResolvedState = { message: init, timestamp: timestampOf(init), source: 'init' };
	const ordered = [...candidates].sort(comparePosition);
	for (const c of ordered) {
		if (authority === undefined || !c.committers.includes(authority)) continue; // §4.1
		const ts = timestampOf(c.message);
		if (ts > state.timestamp) {
			// §4.2: strictly greater
			state = { message: c.message, timestamp: ts, source: 'set' };
		}
	}
	return state;
}

/** Convenience: the current effective value of a reference (§4–5). */
export function resolveValue(args: {
	init: ReferenceMessage;
	authority: Address | undefined;
	candidates: Candidate[];
}): unknown {
	return effectiveValue(currentState(args).message);
}

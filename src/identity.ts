import type { Address, ReferenceMessage } from './types.js';

/** An init identifies its own reference, so it carries no `reference-id` (§2). */
export function isInit(message: ReferenceMessage): boolean {
	return message['reference-id'] === undefined;
}

/**
 * A message's reference id is its `reference-id` key if present, else its own
 * committed id (supplied by the caller, since deriving it needs the commitment).
 */
export function referenceIdOf(message: ReferenceMessage, committedId?: string): string | undefined {
	return (message['reference-id'] as string | undefined) ?? committedId;
}

/** The authority is the init's `authority` key if present, else its sole committer (§2). */
export function authorityOf(init: ReferenceMessage, committers: Address[] = []): Address | undefined {
	return (init.authority as Address | undefined) ?? committers[0];
}

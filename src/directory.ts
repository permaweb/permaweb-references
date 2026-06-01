/**
 * The namespace directory. On the live deployment it is an Arweave manifest
 * (`paths: { "<name>": { id } }`) that the namespace reference points at; the
 * entry id is either a content target (manifest model) or a per-name reference
 * id (scenario-2 model), which `resolve(name, { chain: true })` dereferences.
 */
export interface DirectoryEntry {
	name: string;
	id: string;
}

export interface ParsedDirectory {
	/** The directory document (manifest) id the namespace currently points at. */
	id?: string;
	paths: Record<string, { id: string }>;
}

/** Parse an Arweave-manifest directory document. Tolerates a missing `paths`. */
export function parseManifest(text: string): ParsedDirectory {
	const doc: unknown = JSON.parse(text);
	const paths =
		doc && typeof doc === 'object' && 'paths' in doc && (doc as any).paths && typeof (doc as any).paths === 'object'
			? ((doc as any).paths as Record<string, { id: string }>)
			: {};
	return { paths };
}

export interface ListOptions {
	search?: string;
	cursor?: number;
	limit?: number;
}

export interface ListResult {
	entries: DirectoryEntry[];
	total: number;
	nextCursor?: number;
}

/** List/search/paginate directory entries (pure, over an already-decoded directory). */
export function listEntries(paths: Record<string, { id: string }>, opts: ListOptions = {}): ListResult {
	const search = opts.search?.trim().toLowerCase();
	let names = Object.keys(paths);
	if (search) names = names.filter((n) => n.toLowerCase().includes(search));
	names.sort();
	const total = names.length;
	const start = opts.cursor ?? 0;
	const limit = opts.limit ?? names.length;
	const entries: DirectoryEntry[] = [];
	for (const name of names.slice(start, start + limit)) {
		const entry = paths[name];
		if (entry) entries.push({ name, id: entry.id });
	}
	const end = start + entries.length;
	return { entries, total, nextCursor: end < total ? end : undefined };
}

export function lookupEntry(paths: Record<string, { id: string }>, name: string): DirectoryEntry | null {
	const entry = paths[name];
	return entry ? { name, id: entry.id } : null;
}

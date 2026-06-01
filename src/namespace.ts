/**
 * The namespace: a fixed arweave-manifest snapshot mapping `name -> reference-id`
 * (`paths: { "<name>": { id } }`). We index it both ways so `findReferences` can
 * turn a reference id back into its name.
 */
export interface Namespace {
	/** name -> reference-id */
	names: Record<string, string>;
	/** reference-id -> name */
	byReference: Record<string, string>;
}

export function parseNamespace(text: string): Namespace {
	const doc: unknown = JSON.parse(text);
	const paths: Record<string, unknown> =
		doc && typeof doc === 'object' && 'paths' in doc && (doc as { paths?: unknown }).paths
			? ((doc as { paths: Record<string, unknown> }).paths)
			: {};
	const names: Record<string, string> = {};
	const byReference: Record<string, string> = {};
	for (const [name, entry] of Object.entries(paths)) {
		const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : entry;
		if (typeof id === 'string') {
			names[name] = id;
			byReference[id] = name;
		}
	}
	return { names, byReference };
}

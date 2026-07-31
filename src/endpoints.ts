const DIRECT_BUNDLER_PATH = /\/(?:tx|item)~bundler@1\.0$/;
const TWO_STEP_BUNDLER_PATH = /^(.*)\/~bundler@1\.0\/(?:tx|item)$/;

/** Resolve the upload endpoint for a reference ANS-104 data item. */
export function bundlerDataItemEndpoint(origin: string): string {
	try {
		const url = new URL(origin);
		const pathname = url.pathname.replace(/\/+$/, '');
		const twoStep = pathname.match(TWO_STEP_BUNDLER_PATH);

		// A reference init commits device=reference@1.0. Invoke the bundler
		// directly so that committed device cannot replace it before tx resolves.
		if (twoStep) {
			url.pathname = `${twoStep[1] ?? ''}/tx~bundler@1.0`;
			return url.toString();
		}

		if (DIRECT_BUNDLER_PATH.test(pathname)) return url.toString();
	} catch {
		// Fall through to the legacy endpoint behavior so fetch reports bad URLs.
	}

	return transactionEndpoint(origin);
}

/** Resolve the upload endpoint for a layer-1 Arweave transaction. */
export function transactionEndpoint(origin: string): string {
	try {
		const url = new URL(origin);
		const pathname = url.pathname.replace(/\/+$/, '');
		if (pathname.endsWith('/tx') || pathname.endsWith('/item')) return url.toString();
		url.pathname = `${pathname}/tx`;
		return url.toString();
	} catch {
		const base = origin.replace(/\/+$/, '');
		return base.endsWith('/tx') ? base : `${base}/tx`;
	}
}

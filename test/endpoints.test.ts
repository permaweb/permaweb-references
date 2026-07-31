import { describe, expect, it } from 'vitest';
import { bundlerDataItemEndpoint, transactionEndpoint } from '../src/endpoints';

describe('bundlerDataItemEndpoint', () => {
	it('rewrites two-step HyperBEAM item routes to direct bundler invocation', () => {
		expect(
			bundlerDataItemEndpoint(
				'http://localhost:8734/~bundler@1.0/item?codec-device=ans104@1.0&accept=json@1.0'
			)
		).toBe('http://localhost:8734/tx~bundler@1.0?codec-device=ans104@1.0&accept=json@1.0');
	});

	it('rewrites two-step HyperBEAM tx routes to direct bundler invocation', () => {
		expect(bundlerDataItemEndpoint('http://localhost:8734/~bundler@1.0/tx?codec-device=ans104@1.0')).toBe(
			'http://localhost:8734/tx~bundler@1.0?codec-device=ans104@1.0'
		);
	});

	it('preserves direct-device routes and their query parameters', () => {
		const endpoint = 'http://localhost:8734/tx~bundler@1.0?codec-device=ans104@1.0&accept=json@1.0';
		expect(bundlerDataItemEndpoint(endpoint)).toBe(endpoint);
	});

	it('appends tx to ordinary bundler origins without corrupting their query', () => {
		expect(bundlerDataItemEndpoint('https://bundler.example/upload?token=abc')).toBe(
			'https://bundler.example/upload/tx?token=abc'
		);
	});

	it('preserves complete legacy bundler endpoints', () => {
		expect(bundlerDataItemEndpoint('https://up.arweave.net/tx')).toBe('https://up.arweave.net/tx');
	});
});

describe('transactionEndpoint', () => {
	it('appends tx while preserving query parameters', () => {
		expect(transactionEndpoint('https://arweave.example/gateway?token=abc')).toBe(
			'https://arweave.example/gateway/tx?token=abc'
		);
	});
});

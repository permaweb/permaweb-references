import { describe, it, expect } from 'vitest';
import { buildInit, buildSet, buildPointer } from '../src/messages';

const tagMap = (tags: { name: string; value: string }[]) => Object.fromEntries(tags.map((t) => [t.name, t.value]));

describe('buildSet / §3', () => {
	it('produces exactly the reference@1.0 set tags', () => {
		const { tags } = buildSet({ referenceId: 'R', value: 'TARGET', timestamp: 1780000000000 });
		const map = tagMap(tags);
		expect(map.device).toBe('reference@1.0');
		expect(map['reference-id']).toBe('R');
		expect(map['reference-value']).toBe('TARGET');
		expect(map.timestamp).toBe('1780000000000');
	});
});

describe('buildInit / §3', () => {
	it('carries no reference-id (an init identifies its own reference)', () => {
		const { message, tags } = buildInit({ value: 'TARGET', timestamp: 1 });
		expect(message['reference-id']).toBeUndefined();
		expect(tags.find((t) => t.name === 'reference-id')).toBeUndefined();
		expect(tagMap(tags).device).toBe('reference@1.0');
	});

	it('includes the authority when given', () => {
		const { tags } = buildInit({ authority: 'AUTH', value: 'X' });
		expect(tagMap(tags).authority).toBe('AUTH');
	});
});

describe('buildPointer / §9', () => {
	it('is the minimal downstream handle', () => {
		expect(buildPointer('D')).toEqual({ device: 'reference@1.0', 'reference-id': 'D' });
	});
});

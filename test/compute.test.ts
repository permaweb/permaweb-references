import { describe, it, expect } from 'vitest';
import { currentState, effectiveValue, resolveValue } from '../src/compute';
import type { Candidate, ReferenceMessage } from '../src/types';

const A = 'authority-addr';
const IMPOSTER = 'imposter-addr';

const init = (over: Partial<ReferenceMessage> = {}): ReferenceMessage => ({
	device: 'reference@1.0',
	timestamp: 1,
	...over,
});

const setCand = (ts: number, value: unknown, block: number, index = 0, committer = A): Candidate => ({
	message: { device: 'reference@1.0', 'reference-id': 'R', timestamp: ts, 'reference-value': value },
	committers: [committer],
	position: { block, index },
});

// Vectors mirror the Erlang dev_reference EUnit suite.
describe('currentState / §4 fold', () => {
	it('returns the init value when no set has been applied', () => {
		const s = currentState({ init: init({ 'reference-value': { foo: 'v1' } }), authority: A, candidates: [] });
		expect(s.source).toBe('init');
		expect(effectiveValue(s.message)).toEqual({ foo: 'v1' });
	});

	it('returns the latest set value', () => {
		const s = currentState({ init: init(), authority: A, candidates: [setCand(2, { x: 42 }, 100)] });
		expect(s.source).toBe('set');
		expect(effectiveValue(s.message)).toEqual({ x: 42 });
	});

	it('ignores a stale (lower-timestamp) set regardless of arrival order', () => {
		const cands = [setCand(5, { x: 'new' }, 100), setCand(3, { x: 'old' }, 101)];
		expect(resolveValue({ init: init(), authority: A, candidates: cands })).toEqual({ x: 'new' });
	});

	it('ignores a set from the wrong authority', () => {
		const bogus = setCand(99, { x: 'hax' }, 100, 0, IMPOSTER);
		const s = currentState({ init: init({ 'reference-value': { x: 'orig' } }), authority: A, candidates: [bogus] });
		expect(s.source).toBe('init');
		expect(effectiveValue(s.message)).toEqual({ x: 'orig' });
	});

	it('breaks equal-timestamp ties by earliest data-layer position', () => {
		const early = setCand(5, { x: 'early' }, 100, 0);
		const late = setCand(5, { x: 'late' }, 100, 1);
		// Input order must not matter: the earliest position wins.
		expect(resolveValue({ init: init(), authority: A, candidates: [late, early] })).toEqual({ x: 'early' });
		expect(resolveValue({ init: init(), authority: A, candidates: [early, late] })).toEqual({ x: 'early' });
	});

	it('a directory update replaces the whole directory (reference set, §9)', () => {
		const ptr = (id: string) => ({ device: 'reference@1.0', 'reference-id': id });
		const dir1 = { alice: ptr('D_alice') };
		const dir2 = { alice: ptr('D_alice'), carol: ptr('D_carol') };
		const s = currentState({ init: init({ 'reference-value': dir1 }), authority: A, candidates: [setCand(2, dir2, 100)] });
		expect(effectiveValue(s.message)).toEqual(dir2);
	});
});

describe('effectiveValue / §3', () => {
	it('falls back to the message itself when there is no reference-value', () => {
		const msg = { device: 'reference@1.0', foo: 'bar' };
		expect(effectiveValue(msg)).toEqual(msg);
	});

	it('uses reference-value when present', () => {
		expect(effectiveValue({ device: 'reference@1.0', 'reference-value': { baz: 1 } })).toEqual({ baz: 1 });
	});
});

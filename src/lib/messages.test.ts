import { describe, expect, it, vi } from 'vitest';
import { __registry, NS, nextRequestId, resolvePending } from './messages';

describe('messages registry', () => {
  it('generates unique request ids', () => {
    expect(nextRequestId()).not.toBe(nextRequestId());
  });
  it('resolves a pending promise by requestId', async () => {
    const id = nextRequestId();
    const p = new Promise((resolve) => __registry.set(id, { resolve, reject: vi.fn() }));
    resolvePending(id, { ok: 1 });
    expect(await p).toEqual({ ok: 1 });
    expect(__registry.has(id)).toBe(false);
  });
  it('exports the default namespace', () => {
    expect(NS).toBe('default');
  });
});

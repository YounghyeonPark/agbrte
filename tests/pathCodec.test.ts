import { describe, expect, it } from 'vitest';
import { resolve, sep } from 'node:path';
import { PathCodec } from '@main/store/pathCodec.js';

const ROOT = resolve('/tmp/agbrte-ws');

describe('PathCodec', () => {
  const codec = new PathCodec(ROOT);

  it('encodes an inside path as workspace-relative with POSIX separators', () => {
    const encoded = codec.encode(resolve(ROOT, 'src/server/auth.ts'));
    expect(encoded).toEqual({ $ws: 'src/server/auth.ts' });
    // The stored form must not leak the writing platform's separator, or a log
    // written on Windows cannot be read on Linux (§5.4b).
    expect(JSON.stringify(encoded)).not.toContain('\\\\');
  });

  it('round-trips through a decode back to the same absolute path', () => {
    const abs = resolve(ROOT, 'a/b/c.ts');
    expect(codec.decode(codec.encode(abs))).toBe(abs);
  });

  it('encodes the root itself', () => {
    expect(codec.encode(ROOT)).toEqual({ $ws: '.' });
    expect(codec.decode({ $ws: '.' })).toBe(ROOT);
  });

  it('flags a path that escapes the workspace as external', () => {
    const outside = resolve(ROOT, '../elsewhere/secret.env');
    const encoded = codec.encode(outside);
    expect(encoded).toEqual({ abs: outside, external: true });
    expect(codec.isPortable(encoded)).toBe(false);
  });

  it('treats inside paths as portable', () => {
    expect(codec.isPortable(codec.encode(resolve(ROOT, 'x.ts')))).toBe(true);
  });

  it('resolves the same relative path against a moved root — the point of the exercise', () => {
    const encoded = codec.encode(resolve(ROOT, 'src/index.ts'));
    const moved = codec.rebase(resolve('/mnt/other/agbrte-ws'));
    expect(moved.decode(encoded)).toBe(resolve('/mnt/other/agbrte-ws/src/index.ts'));
  });

  it('normalizes traversal that stays inside the workspace', () => {
    expect(codec.encode(resolve(ROOT, 'a/../b/c.ts'))).toEqual({ $ws: 'b/c.ts' });
  });

  it('accepts a root-relative input as well as an absolute one', () => {
    expect(codec.encode('src/main.ts')).toEqual({ $ws: 'src/main.ts' });
  });

  it('decodes an external path unchanged', () => {
    const abs = resolve('/etc/hosts');
    expect(codec.decode({ abs, external: true })).toBe(abs);
  });

  it('uses the platform separator on decode', () => {
    const decoded = codec.decode({ $ws: 'src/deep/file.ts' });
    expect(decoded.includes(sep)).toBe(true);
  });
});

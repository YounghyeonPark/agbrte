/**
 * Inline images in a terminal that can take them (§12).
 *
 * These assert the bytes, because that is the whole surface: a wrong escape
 * does not throw, it sprays base64 across somebody's transcript. There is no
 * feedback channel — terminals do not acknowledge a graphics sequence — so the
 * spec is the only oracle, and the tests encode it.
 */

import { describe, expect, it } from 'vitest';
import { detectGraphics, inlineImage } from '../src/cli/graphics.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('which protocol the terminal speaks', () => {
  it('reads the terminal own claim rather than guessing', () => {
    expect(detectGraphics({ TERM: 'xterm-kitty' })).toBe('kitty');
    expect(detectGraphics({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectGraphics({ TERM_PROGRAM: 'ghostty' })).toBe('kitty');
    expect(detectGraphics({ TERM_PROGRAM: 'WezTerm' })).toBe('kitty');
    expect(detectGraphics({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
  });

  it('says no when nothing said yes', () => {
    // The important direction. An unrecognised terminal that gets sent a
    // graphics sequence prints its bytes, so silence has to mean "do not".
    expect(detectGraphics({})).toBe('none');
    expect(detectGraphics({ TERM: 'xterm-256color' })).toBe('none');
  });

  it('declines inside a multiplexer', () => {
    // The sequence reaches tmux rather than the terminal, and passing it
    // through needs per-multiplexer wrapping that only sometimes works.
    expect(detectGraphics({ TMUX: '/tmp/tmux-1000/default,1,0', TERM: 'xterm-kitty' })).toBe('none');
    expect(detectGraphics({ TERM: 'screen.xterm-256color' })).toBe('none');
  });

  it('lets a person override it, because ssh and multiplexers hide the truth', () => {
    expect(detectGraphics({ AGBRTE_TERM_GRAPHICS: 'kitty', TMUX: 'x' })).toBe('kitty');
    expect(detectGraphics({ AGBRTE_TERM_GRAPHICS: 'none', TERM: 'xterm-kitty' })).toBe('none');
  });
});

describe('the bytes on the wire', () => {
  it('wraps iTerm2 in OSC 1337 and closes with BEL', () => {
    const out = inlineImage(PNG, { graphics: 'iterm2' })!;
    expect(out.startsWith('\x1b]1337;File=')).toBe(true);
    expect(out).toContain('inline=1');
    // Required: iTerm2 uses it to know when the payload is complete.
    expect(out).toContain(`size=${PNG.length}`);
    expect(out).toContain(Buffer.from(PNG).toString('base64'));
    expect(out).toContain('\x07');
  });

  it('wraps kitty in APC and terminates each chunk with ST', () => {
    const out = inlineImage(PNG, { graphics: 'kitty' })!;
    expect(out.startsWith('\x1b_Ga=T,f=100,m=0;')).toBe(true);
    expect(out).toContain('\x1b\\');
  });

  it('chunks kitty, because one write can exceed what a pty accepts', () => {
    const big = new Uint8Array(9_000);
    const out = inlineImage(big, { graphics: 'kitty' })!;
    const chunks = out.split('\x1b_G').length - 1;
    expect(chunks).toBeGreaterThan(1);
    // Every chunk but the last says more is coming; the last says it is done.
    expect(out).toContain('m=1;');
    expect(out.includes('m=0;')).toBe(true);
  });

  it('returns null rather than bytes a terminal would print as text', () => {
    expect(inlineImage(PNG, { graphics: 'none' })).toBeNull();
  });
});

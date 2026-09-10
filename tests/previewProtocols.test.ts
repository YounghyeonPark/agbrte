/**
 * Which forwarded ports get a browser link (DESIGN.md §6.8, §3.5).
 *
 * A forward is a generic TCP tunnel, and the session view presented every one as
 * a browser link because §6.8 was written about dev servers. Tunnelling `3389`
 * brings a machine's desktop to a local address — the answer to "I want to see
 * the screen of the PC this session runs on" — and a link to
 * `http://127.0.0.1:54321` is then a control that fails on press, in front of an
 * address that works the moment it is text.
 *
 * The table is deliberately short and the default is deliberately permissive: a
 * dev server listens wherever it was told to, so "not recognised" has to mean "a
 * browser is worth offering". These tests pin that asymmetry, because the
 * tempting change — recognise only what is known to be HTTP — would quietly
 * break the case the feature exists for.
 */

import { describe, expect, it } from 'vitest';
import { browserCanOpen, protocolOn } from '../src/shared/preview/protocols.js';

describe('ports a browser should not be pointed at', () => {
  it('refuses the two that carry a screen, and names them', () => {
    for (const port of [3389, 5900, 5901]) {
      expect(browserCanOpen(port), String(port)).toBe(false);
      // The label is the hint: a bare `:3389` on a build box is a number, and
      // named it is an offer to see that machine's screen.
      expect(protocolOn(port)?.label, String(port)).toMatch(/remote desktop/);
    }
  });

  it('refuses the other wire protocols it knows', () => {
    for (const port of [22, 5432, 3306, 6379]) {
      expect(browserCanOpen(port), String(port)).toBe(false);
      expect(protocolOn(port)?.label, String(port)).toBeTruthy();
    }
  });
});

describe('everything else keeps its link', () => {
  it('offers a browser for a port nobody here has an opinion about', () => {
    /*
     * The asymmetry, and the reason it runs this way round. A dev server listens
     * on whatever it was told to — 3000, 5173, 4321, 61000 — so refusing a link
     * unless the port is recognised would break §6.8's whole case. Being wrong
     * here costs a tab that does not load.
     */
    for (const port of [3000, 5173, 4321, 8000, 61000]) {
      expect(browserCanOpen(port), String(port)).toBe(true);
      expect(protocolOn(port), String(port)).toBeNull();
    }
  });

  it('names a port it recognises and still offers the browser', () => {
    // Knowing what something is and refusing to open it are separate answers.
    expect(protocolOn(11434)?.label).toBe('ollama');
    expect(browserCanOpen(11434)).toBe(true);
    expect(browserCanOpen(8080)).toBe(true);
  });
});

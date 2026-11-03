/**
 * The pieces of the terminal client that need no terminal (`src/cli/terminal/`).
 *
 * The client puts a shell and an agent in one raw terminal, so it reads keys
 * itself, edits the agent's line itself and draws replies itself — readline
 * owns stdin and cannot share it. What is pinned here is what goes wrong in
 * those three when nobody checks: a key split across two reads, a cursor in the
 * wrong column on a line of Korean, and Markdown printed as punctuation.
 */

import { describe, expect, it } from 'vitest';
import { KeyReader, type Key } from '../src/main/terminal/mux/keys.js';
import { draw, edit, emptyLine, lineText, type LineState } from '../src/main/terminal/mux/lineEditor.js';
import { plainStyle, renderInline, renderMarkdown, type Style } from '../src/main/terminal/mux/markdown.js';
import { displayWidth, stripAnsi } from '../src/main/terminal/mux/width.js';

const ESC = '\u001b';

describe('display width', () => {
  it('counts Hangul and CJK as two columns, and escape sequences as none', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('안녕')).toBe(4);
    expect(displayWidth('日本')).toBe(4);
    expect(displayWidth(`${ESC}[1mbold${ESC}[22m`)).toBe(4);
    expect(displayWidth('é')).toBe(1); // e and a combining acute: one column
  });

  it('strips links as well as colours', () => {
    expect(stripAnsi(`${ESC}]8;;https://x${'\u0007'}x${ESC}]8;;${'\u0007'}`)).toBe('x');
  });
});

describe('keys', () => {
  const all = (chunks: string[]): Key[] => {
    const reader = new KeyReader();
    return chunks.flatMap((c) => reader.push(c));
  };

  it('reads text, Enter, arrows and control keys', () => {
    expect(all(['ab\r', `${ESC}[A`, '\u0003', '\u0000'])).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'enter' },
      { kind: 'up' },
      { kind: 'ctrl', key: 'c' },
      { kind: 'ctrl', key: '@' },
    ]);
  });

  it('waits for a sequence the read cut in half', () => {
    expect(all([ESC, '[D'])).toEqual([{ kind: 'left' }]);
    expect(all([`${ESC}[`, '3~'])).toEqual([{ kind: 'delete' }]);
  });

  it('calls a lone ESC the Escape key only when nothing follows', () => {
    const reader = new KeyReader();
    expect(reader.push(ESC)).toEqual([]);
    expect(reader.flushPending()).toEqual([{ kind: 'escape' }]);
  });

  it('reads a bracketed paste as one paste, newlines and all, however it is split', () => {
    const paste = `${ESC}[200~line one\r\nline two${ESC}[201~`;
    for (let cut = 1; cut < paste.length; cut += 1) {
      expect(all([paste.slice(0, cut), paste.slice(cut)]), `cut at ${cut}`).toEqual([
        { kind: 'paste', text: 'line one\nline two' },
      ]);
    }
  });

  it('reads Ctrl+Right as Right rather than dropping it', () => {
    expect(all([`${ESC}[1;5C`])).toEqual([{ kind: 'right' }]);
  });
});

describe('the line', () => {
  const type = (state: LineState, ...keys: Key[]): LineState =>
    keys.reduce((s, k) => edit(s, k).state, state);

  it('edits where the cursor is, as a shell does', () => {
    let s = type(emptyLine(), { kind: 'text', text: 'helo' }, { kind: 'left' }, { kind: 'text', text: 'l' });
    expect(lineText(s)).toBe('hello');
    s = type(s, { kind: 'ctrl', key: 'a' }, { kind: 'text', text: '> ' });
    expect(lineText(s)).toBe('> hello');
    s = type(s, { kind: 'ctrl', key: 'e' }, { kind: 'text', text: ' world  ' }, { kind: 'ctrl', key: 'w' });
    expect(lineText(s)).toBe('> hello ');
  });

  it('submits, remembers, and walks back through what was sent', () => {
    let s = type(emptyLine(), { kind: 'text', text: 'first' });
    const sent = edit(s, { kind: 'enter' });
    expect(sent.outcome).toEqual({ kind: 'submit', line: 'first' });
    s = type(sent.state, { kind: 'text', text: 'draft' }, { kind: 'up' });
    expect(lineText(s)).toBe('first');
    s = type(s, { kind: 'down' });
    expect(lineText(s)).toBe('draft');
  });

  it('hands back the keys that belong to its owner', () => {
    expect(edit(emptyLine(), { kind: 'ctrl', key: 'c' }).outcome).toEqual({ kind: 'pass', key: { kind: 'ctrl', key: 'c' } });
    // Ctrl+D leaves only on an empty line, as in a shell.
    expect(edit(emptyLine(), { kind: 'ctrl', key: 'd' }).outcome.kind).toBe('pass');
    const typed = type(emptyLine(), { kind: 'text', text: 'ab' }, { kind: 'left' });
    expect(lineText(edit(typed, { kind: 'ctrl', key: 'd' }).state)).toBe('a');
  });

  it('puts the cursor in the right column on a line of Korean', () => {
    const s = type(emptyLine(), { kind: 'text', text: '안녕하세요' }, { kind: 'left' }, { kind: 'left' });
    const out = draw(s, '> ', 80, { rows: 1, cursorRow: 0 });
    // Prompt 2 + three wide characters 6 = column 8.
    expect(out.bytes.endsWith(`\r${ESC}[8C`)).toBe(true);
  });

  it('clears every row a wrapped line took before drawing it again', () => {
    const long = type(emptyLine(), { kind: 'text', text: 'x'.repeat(25) });
    const first = draw(long, '> ', 10, { rows: 1, cursorRow: 0 });
    expect(first.rows).toBe(3);
    const second = draw(long, '> ', 10, first);
    expect(second.bytes.startsWith(`${ESC}[${first.cursorRow}A\r${ESC}[J`)).toBe(true);
  });
});

describe('a reply, rendered', () => {
  const tag: Style = {
    bold: (s) => `<b>${s}</b>`,
    italic: (s) => `<i>${s}</i>`,
    dim: (s) => `<d>${s}</d>`,
    accent: (s) => `<a>${s}</a>`,
    code: (s) => `<c>${s}</c>`,
    link: (t, u) => `<l ${u}>${t}</l>`,
  };

  it('turns emphasis, code and links into styles, and leaves code alone inside', () => {
    expect(renderInline('**bold** and *it* and `a*b*c` and [doc](https://x.y)', tag)).toBe(
      '<b>bold</b> and <i>it</i> and <c>a*b*c</c> and <l https://x.y>doc</l>',
    );
  });

  it('does not read a multiplication or a snake_case name as emphasis', () => {
    expect(renderInline('2 * 3 * 4 and my_var_name', tag)).toBe('2 * 3 * 4 and my_var_name');
  });

  it('draws headings, lists, quotes and fenced code the way a terminal can', () => {
    const out = renderMarkdown('# Title\n\n- one\n2. two\n> said\n```ts\nconst a = 1;\n```\n---', tag, 20);
    expect(out).toEqual([
      '<b><a>Title</a></b>',
      '',
      '<a>•</a> one',
      '<a>2.</a> two',
      '<d>│</d> <d>said</d>',
      '  <d>ts</d>',
      '  <c>const a = 1;</c>',
      `<d>${'─'.repeat(20)}</d>`,
    ]);
  });

  it('is plain text where the terminal cannot draw styles', () => {
    expect(renderMarkdown('**a** [b](http://c)', plainStyle)).toEqual(['a b (http://c)']);
  });
});

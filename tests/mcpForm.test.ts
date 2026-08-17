/**
 * The creation form's half of §17 Q20 — the parts that are decidable without a
 * browser.
 *
 * Two properties are worth a test here and neither is about React. The first is
 * that what somebody types becomes the config the host would have accepted:
 * argv split the way a shell would not (there is no shell — `McpConnection`
 * spawns with `shell: false` on purpose), and a name refused before a round trip
 * makes a session nobody wanted. The second is §13's: an `env` value is a
 * credential, so it must appear in exactly one place — the config that crosses
 * `session.create` — and nowhere a log, a title or a template could pick it up.
 *
 * The e2e spec drives the same fields through the real app; this is the fast
 * check that stays honest when nobody is watching.
 */

import { describe, expect, it } from 'vitest';
import {
  draftProblem,
  emptyDraft,
  firstProblem,
  splitArgs,
  toConfigs,
  type McpDraft,
} from '../src/renderer/mcpConfig.js';

const draft = (over: Partial<McpDraft> = {}): McpDraft => ({
  ...emptyDraft(),
  id: 'search',
  command: 'node',
  ...over,
});

describe('what was typed becomes argv', () => {
  it('splits on whitespace and keeps a quoted path whole', () => {
    // The case this exists for: a Windows path with a space in it, split into
    // three arguments, producing a spawn failure that names half a path.
    expect(splitArgs('"C:/Program Files/x/cli.js" --server')).toEqual([
      'C:/Program Files/x/cli.js',
      '--server',
    ]);
  });

  it('leaves an apostrophe alone, because a path may contain one', () => {
    expect(splitArgs("/home/o'brien/cli.js --server")).toEqual(['/home/o\'brien/cli.js', '--server']);
  });

  it('keeps a deliberately empty argument and drops incidental whitespace', () => {
    expect(splitArgs('  a   ""  b ')).toEqual(['a', '', 'b']);
    expect(splitArgs('   ')).toEqual([]);
  });
});

describe('a name that could not become a tool name is refused here', () => {
  it('names the rule, because the id is spliced into policy-matched names', () => {
    expect(draftProblem(draft({ id: 'Bad Id!' }), [])).toContain('lowercase');
  });

  it('catches a duplicate, which the host refuses for the whole create', () => {
    const a = draft();
    const b = draft();
    expect(firstProblem([a, b])).toContain('unique');
  });

  it('says nothing about a row nobody has filled in', () => {
    // Pressing "add a server" and changing your mind is ordinary, and must not
    // block the Create button.
    expect(draftProblem(emptyDraft(), [])).toBeNull();
    expect(firstProblem([emptyDraft()])).toBeNull();
  });

  it('refuses a value typed into a row with no variable name', () => {
    const problem = draftProblem(draft({ env: [{ key: '', value: 'sekrit' }] }), []);
    expect(problem).toContain('no name');
    // …and the refusal does not quote the value back.
    expect(problem).not.toContain('sekrit');
  });
});

describe('an env value goes to the config and nowhere else', () => {
  it('is carried into the config the host receives', () => {
    const configs = toConfigs([
      draft({ args: 'cli.js --server', env: [{ key: 'TOKEN', value: 'sekrit-value-1234' }] }),
    ]);
    expect(configs).toEqual([
      { id: 'search', command: 'node', args: ['cli.js', '--server'], env: { TOKEN: 'sekrit-value-1234' } },
    ]);
  });

  it('drops an unfilled row rather than sending a server with no command', () => {
    expect(toConfigs([emptyDraft(), draft()])).toEqual([{ id: 'search', command: 'node' }]);
  });

  it('omits env entirely when there is none, rather than sending {}', () => {
    // `mcp.attached` records `envKeys` from this; an empty array would claim a
    // server was given an environment it was not.
    const [config] = toConfigs([draft({ env: [{ key: '  ', value: '' }] })]);
    expect(config).not.toHaveProperty('env');
  });

  it('trims a name but never a value', () => {
    // A trailing space in a token is a real token character, and silently
    // trimming one produces an auth failure nobody can explain.
    const [config] = toConfigs([draft({ env: [{ key: ' TOKEN ', value: ' padded ' }] })]);
    expect(config?.env).toEqual({ TOKEN: ' padded ' });
  });
});

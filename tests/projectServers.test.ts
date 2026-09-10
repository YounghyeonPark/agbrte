/**
 * MCP servers a workspace declares (DESIGN.md §17 Q20, §17 Q12, §13, §5.4b).
 *
 * One property matters more than the rest and the others exist to protect it:
 * **this file is committed, so it must have nowhere to put a credential.** The
 * declaration carries `envFrom` — the variable a server wants, mapped to the
 * name the machine stores it under — and both halves are validated as
 * environment-variable names, so a pasted key fails on the name rule.
 *
 * That is stronger than checking that an `env` value looks like `${…}`, and the
 * difference is the whole reason for the shape: a refusal on read stops a bad
 * file being *used*, not being *committed*, and by the time anyone reads it the
 * key is in every clone. `workflows.ts` makes the identical argument about its
 * own type having no field a secret fits in.
 *
 * The rest is the shape the two neighbours already have: a broken file is a row
 * with its reason, an id is refused rather than sanitised, and one directory
 * holds three kinds of template distinguished only by suffix.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listProjectServers,
  neededNames,
  readProjectServer,
  writeProjectServer,
  PROJECT_SERVER_SUFFIX,
} from '../src/main/store/projectServers.js';
import { catalogueServers } from '../src/shared/mcp/catalogue.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-mcpdecl-'));
  made.push(root);
  await mkdir(join(root, '.agbrte', 'templates'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(
      join(root, '.agbrte', 'templates', name),
      typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      'utf8',
    );
  }
  return root;
}

const GOOD = {
  command: 'npx',
  args: ['-y', '@some/mcp-search'],
  envFrom: { API_KEY: 'SEARCH_API_KEY' },
};

describe('reading one', () => {
  it('takes the id from the filename and the rest from the file', async () => {
    const root = await workspace({ [`search${PROJECT_SERVER_SUFFIX}`]: GOOD });
    const found = await readProjectServer(root, 'search');
    expect(found.problems).toEqual([]);
    expect(found.server).toEqual({
      id: 'search',
      command: 'npx',
      args: ['-y', '@some/mcp-search'],
      envFrom: { API_KEY: 'SEARCH_API_KEY' },
    });
    // The mapping read the useful way round: the server wants `API_KEY`, and
    // this machine is asked for `SEARCH_API_KEY`.
    expect(neededNames(found.server as never)).toEqual(['SEARCH_API_KEY']);
  });

  it('refuses an env block by name, rather than dropping it', async () => {
    const root = await workspace({
      [`search${PROJECT_SERVER_SUFFIX}`]: { command: 'npx', env: { API_KEY: 'sk-live-abcdef' } },
    });
    const found = await readProjectServer(root, 'search');
    /*
     * Somebody writing this file reaches for the field the creation form has. A
     * silently dropped `env` would be a server that starts without its
     * credentials and fails somewhere far away, so the refusal says *why* —
     * which is the sentence that stops the next attempt pasting a key too.
     */
    expect(found.server).toBeUndefined();
    expect(found.problems[0]).toContain('committed');
    expect(found.problems[0]).toContain('envFrom');
  });

  it('refuses a value where a name belongs, which is what a pasted key is', async () => {
    const root = await workspace({
      [`search${PROJECT_SERVER_SUFFIX}`]: {
        command: 'npx',
        envFrom: { API_KEY: 'sk-live-abcdef-not-a-name' },
      },
    });
    const found = await readProjectServer(root, 'search');
    expect(found.server).toBeUndefined();
    expect(found.problems[0]).toContain('not hold a value');
    // And the refusal does not repeat the thing that should not be there.
    expect(found.problems.join(' ')).not.toContain('sk-live-abcdef-not-a-name');
  });

  it('refuses a variable name an environment could not carry', async () => {
    const root = await workspace({
      [`search${PROJECT_SERVER_SUFFIX}`]: { command: 'npx', envFrom: { 'has space': 'HELD' } },
    });
    expect((await readProjectServer(root, 'search')).problems[0]).toContain(
      'not an environment variable name',
    );
  });

  it('refuses an absolute cwd, which names nothing on a colleague machine', async () => {
    const root = await workspace({
      [`search${PROJECT_SERVER_SUFFIX}`]: { command: 'npx', cwd: '/home/them/project' },
    });
    // §5.4b: a path that crosses a machine names nothing on the far side, and a
    // tracked file crosses every machine that clones it.
    expect((await readProjectServer(root, 'search')).problems[0]).toContain('relative');
  });

  it('refuses a declaration with no command', async () => {
    const root = await workspace({ [`search${PROJECT_SERVER_SUFFIX}`]: { args: ['x'] } });
    expect((await readProjectServer(root, 'search')).problems[0]).toContain('no command');
  });

  it('refuses an id the tool names could not carry, rather than rewriting it', async () => {
    const root = await workspace({ [`Search Server${PROJECT_SERVER_SUFFIX}`]: GOOD });
    // The id becomes part of `mcp__<id>__<tool>`, which policy rules match on,
    // so a silent rename would put a rule on a name nobody wrote.
    const found = await readProjectServer(root, 'Search Server');
    expect(found.server).toBeUndefined();
    expect(found.problems[0]).toContain('cannot be an MCP server id');
  });

  it('reports a file that is not there as a problem, not a throw', async () => {
    const root = await workspace({});
    expect((await readProjectServer(root, 'missing')).problems[0]).toContain('could not be read');
  });
});

describe('writing one', () => {
  it('writes a file a reader accepts, with the fields and nothing else', async () => {
    const root = await workspace({});
    const written = await writeProjectServer(root, {
      id: 'search',
      command: 'npx',
      args: ['-y', 'some-server'],
      envFrom: { API_KEY: 'SEARCH_API_KEY' },
    });
    expect(written.id).toBe('search');
    // The round trip is the assertion that matters: the catalogue's shortcut
    // has to produce the same artifact a person writes by hand, or it is a
    // second way of meaning the same thing (§4.4's convergence argument).
    const read = await readProjectServer(root, 'search');
    expect(read.problems).toEqual([]);
    expect(read.server?.envFrom).toEqual({ API_KEY: 'SEARCH_API_KEY' });
  });

  it('writes JSON a person can read in a diff', async () => {
    const root = await workspace({});
    await writeProjectServer(root, { id: 'search', command: 'npx' });
    const raw = await readFile(join(root, '.agbrte', 'templates', 'search.mcp.json'), 'utf8');
    // Two-space and a trailing newline, like `saveWorkflow`: this is going into
    // somebody's repository and should read like the rest of the tree.
    expect(raw).toBe(['{', '  "command": "npx"', '}', ''].join('\n'));
  });

  it('refuses to replace an id that is taken, and leaves the file alone', async () => {
    const root = await workspace({ [`search${PROJECT_SERVER_SUFFIX}`]: GOOD });
    /*
     * The opposite of `setSecret` and the same as `addEndpoint`: the id is the
     * prefix of `mcp__<id>__*`, which policy rules match on, so swapping the
     * command under an existing one silently changes what every rule pointing
     * at it now permits.
     */
    await expect(
      writeProjectServer(root, { id: 'search', command: 'something-else' }),
    ).rejects.toThrow(/already has/);
    expect((await readProjectServer(root, 'search')).server?.command).toBe('npx');
  });

  it('has no route by which a credential reaches the file', async () => {
    const root = await workspace({});
    // The body is built from the fields the type has, so a caller that grew an
    // `env` cannot put a secret in a repository by accident (§13). Asserted on
    // the bytes, because that is what gets committed.
    await writeProjectServer(root, {
      id: 'search',
      command: 'npx',
      ...({ env: { API_KEY: 'sk-live-abcdef' } } as object),
    });
    const raw = await readFile(join(root, '.agbrte', 'templates', 'search.mcp.json'), 'utf8');
    expect(raw).not.toContain('sk-live-abcdef');
    expect(raw).not.toContain('env');
  });

  it('refuses an id the tool names could not carry', async () => {
    const root = await workspace({});
    await expect(writeProjectServer(root, { id: 'Search', command: 'npx' })).rejects.toThrow(
      /cannot be an MCP server id/,
    );
  });
});

describe('the catalogue the app ships', () => {
  it('pins every version, because npx resolves at run time', async () => {
    /*
     * A security property, not tidiness. `npx -y pkg` fetches whatever the
     * registry serves when the server starts, so an unpinned entry is a promise
     * to execute code nobody here has looked at — and the catalogue's
     * `verifiedAt` would be a claim about a different tarball every week.
     *
     * A pin does not survive a maintainer's account being taken over, which no
     * pin can. It does mean the thing that runs is the thing that was checked.
     */
    for (const entry of catalogueServers()) {
      const pinned = entry.args.some((a) => /@\d+(\.\d+)*$/.test(a));
      expect(pinned, `${entry.id} names no version`).toBe(true);
    }
  });

  it('says what every entry costs to start', async () => {
    // An entry that is silent about cost reads as free, which is how the first
    // version of this list recommended a service wanting a credit card.
    for (const entry of catalogueServers()) {
      expect(['none', 'free-key'], entry.id).toContain(entry.account);
    }
  });

  it('writes something the reader accepts, for every entry', async () => {
    // The catalogue is a shortcut to a file, so an entry that produces a file
    // the reader refuses would be a button that fails after it has written.
    for (const entry of catalogueServers()) {
      const root = await workspace({});
      await writeProjectServer(root, {
        id: entry.id,
        command: entry.command,
        args: entry.args,
        envFrom: entry.envFrom,
      });
      const read = await readProjectServer(root, entry.id);
      expect(read.problems, entry.id).toEqual([]);
      // And it names what it needs, so the form can ask for it.
      expect(neededNames(read.server as never).length, entry.id).toBeGreaterThan(0);
    }
  });

  it('has somewhere to send a person for each value it asks for', async () => {
    for (const entry of catalogueServers()) {
      for (const name of Object.values(entry.envFrom)) {
        // "get a key" is not an instruction, and a masked box cannot say what
        // kind of value it wants.
        expect(entry.asks?.[name], `${entry.id} does not say what ${name} is`).toBeTruthy();
      }
      expect(entry.keyFrom, entry.id).toBeTruthy();
    }
  });
});

describe('listing a workspace', () => {
  it('finds the declarations and leaves the other templates alone', async () => {
    const root = await workspace({
      [`search${PROJECT_SERVER_SUFFIX}`]: GOOD,
      // One directory, three kinds, and the suffix is what tells them apart.
      'review.workflow.json': { id: 'review', name: 'r', goal: 'g', nodes: [] },
      'commits.skill.md': '---\ndescription: d\n---\n\nbody\n',
      'a-session.json': { id: 'x', name: 'not a server' },
    });
    expect((await listProjectServers(root)).map((f) => f.id)).toEqual(['search']);
  });

  it('carries a broken one as a row with its reason, beside the good ones', async () => {
    const root = await workspace({
      [`search${PROJECT_SERVER_SUFFIX}`]: GOOD,
      [`broken${PROJECT_SERVER_SUFFIX}`]: '{ not json',
    });
    const found = await listProjectServers(root);
    expect(found.map((f) => f.id)).toEqual(['broken', 'search']);
    expect(found.find((f) => f.id === 'broken')?.problems[0]).toContain('not valid JSON');
    expect(found.find((f) => f.id === 'search')?.server?.command).toBe('npx');
  });

  it('is an empty list, not a failure, where no templates directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agbrte-mcpdecl-'));
    made.push(root);
    expect(await listProjectServers(root)).toEqual([]);
  });
});

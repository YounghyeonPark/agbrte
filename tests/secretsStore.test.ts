/**
 * The machine's named secrets (DESIGN.md §13, §17 Q20, §5.1).
 *
 * The properties here are the ones the rest of the feature will stand on, and
 * one of them is the whole reason this file exists rather than a `Record` held
 * in memory somewhere.
 *
 * **Names and values have separate readers.** `readSecretNames` is what a
 * client is given and it cannot return a value; `resolveSecrets` is for the
 * spawn on this machine. Two functions rather than one with a flag, because a
 * flag is one typo away from putting a key in a reply — so the pinning here is
 * that the names reader really is names.
 *
 * **The file is `0600` in a `0700` directory**, like `endpoints.json` beside it.
 * That is the whole of what "stored on the machine" is allowed to mean, and it
 * is the sentence the UI will say out loud: anyone who can read that home
 * directory can use the key.
 *
 * **`AGBRTE_HOME` is honoured**, which is CLAUDE.md's second hazard: a
 * `= homedir()` default once made every host in a test run share one socket, and
 * a credentials file has exactly the same mistake available to it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteSecret,
  readSecretNames,
  resolveSecrets,
  secretsPath,
  setSecret,
  SecretRejected,
} from '../src/host/secrets.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env['AGBRTE_HOME'];
});

async function machine(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agbrte-secrets-'));
  made.push(dir);
  return join(dir, 'secrets.json');
}

describe('storing and reading back', () => {
  it('keeps a value and reports the name', async () => {
    const path = await machine();
    expect(await setSecret('SEARCH_API_KEY', 'sk-live-abcdef', path)).toEqual({
      name: 'SEARCH_API_KEY',
    });
    expect(await readSecretNames(path)).toEqual(['SEARCH_API_KEY']);
    expect(await resolveSecrets(['SEARCH_API_KEY'], path)).toEqual({
      SEARCH_API_KEY: 'sk-live-abcdef',
    });
  });

  it('never returns a value from the names reader', async () => {
    const path = await machine();
    await setSecret('SEARCH_API_KEY', 'sk-live-abcdef', path);
    await setSecret('OTHER_TOKEN', 'hunter2', path);
    /*
     * Asserted on the serialised result rather than on a field, because the
     * claim is that a value is *absent* — checking `names[0].value` would pass
     * against a shape that carries it under any other name. This is the one
     * assertion in the file that a refactor must not be able to delete quietly.
     */
    const names = await readSecretNames(path);
    const wire = JSON.stringify(names);
    expect(wire).not.toContain('sk-live-abcdef');
    expect(wire).not.toContain('hunter2');
    // Sorted, so a list a person reads twice reads the same twice.
    expect(names).toEqual(['OTHER_TOKEN', 'SEARCH_API_KEY']);
  });

  it('replaces rather than refusing, because that is what rotating a key is', async () => {
    const path = await machine();
    await setSecret('SEARCH_API_KEY', 'old', path);
    await setSecret('SEARCH_API_KEY', 'new', path);
    // The opposite of `addEndpoint`, deliberately: an endpoint id is what an
    // agent's `AuthMode` names, and a secret name is a variable with no such
    // referent. Refusing here would mean deleting before setting, and a machine
    // briefly holding neither.
    expect(await resolveSecrets(['SEARCH_API_KEY'], path)).toEqual({ SEARCH_API_KEY: 'new' });
    expect(await readSecretNames(path)).toEqual(['SEARCH_API_KEY']);
  });

  it('says a name it does not hold is absent rather than empty', async () => {
    const path = await machine();
    await setSecret('HELD', 'yes', path);
    // "not set" and "set to nothing" are different, and the form has to be able
    // to ask for the missing one.
    expect(await resolveSecrets(['HELD', 'MISSING'], path)).toEqual({ HELD: 'yes' });
  });

  it('forgets one, and forgetting one that is not there is success', async () => {
    const path = await machine();
    await setSecret('A', '1', path);
    await setSecret('B', '2', path);
    await deleteSecret('A', path);
    expect(await readSecretNames(path)).toEqual(['B']);
    // The caller wanted it gone, and it is.
    await expect(deleteSecret('NEVER_EXISTED', path)).resolves.toEqual({ name: 'NEVER_EXISTED' });
  });
});

describe('what it refuses', () => {
  it('refuses a name an environment could not carry', async () => {
    const path = await machine();
    for (const bad of ['has space', '9LEADING_DIGIT', 'has-dash', '']) {
      await expect(setSecret(bad, 'x', path)).rejects.toBeInstanceOf(SecretRejected);
    }
    // Refused rather than sanitised: the name is matched against `${…}` in a
    // project's file, and one silently rewritten resolves nothing while looking
    // like it should.
    expect(await readSecretNames(path)).toEqual([]);
  });

  it('refuses an empty value instead of storing one', async () => {
    const path = await machine();
    // An empty value is indistinguishable from absent everywhere it is used, so
    // storing one would make the form stop asking for a key that is not there.
    await expect(setSecret('EMPTY', '', path)).rejects.toThrow(/delete/);
  });

  it('keeps the value out of the refusal it throws', async () => {
    const path = await machine();
    await expect(setSecret('has space', 'sk-live-abcdef', path)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('sk-live-abcdef') }) as never,
    );
  });
});

describe('the file itself', () => {
  it('is owner-only, in an owner-only directory', async () => {
    const path = await machine();
    await setSecret('SEARCH_API_KEY', 'sk-live-abcdef', path);
    if (process.platform !== 'win32') {
      // The same modes `addEndpoint` sets, which is the whole of what "stored on
      // the machine" is allowed to mean.
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
    }
  });

  it('reads a machine with no file as one holding nothing', async () => {
    const path = await machine();
    expect(await readSecretNames(path)).toEqual([]);
    expect(await resolveSecrets(['ANY'], path)).toEqual({});
  });

  it('reads a corrupt file as empty rather than throwing', async () => {
    const path = await machine();
    await writeFile(path, '{ not json', 'utf8');
    /*
     * Unlike `endpoints.json`, where an unreadable file is refused loudly
     * because the fallback is sending turns somewhere the user did not
     * configure. The fallback here is a missing value, which surfaces as the
     * form asking for it — the same thing a machine that never held one does.
     */
    expect(await readSecretNames(path)).toEqual([]);
  });

  it('drops a hand-written name this build would refuse', async () => {
    const path = await machine();
    await writeFile(
      path,
      JSON.stringify({ secrets: { GOOD: 'yes', 'has space': 'no' } }),
      'utf8',
    );
    // Filtered on the way in as well as on the way out: letting it through here
    // would put it in an environment by a route the validator never saw.
    expect(await readSecretNames(path)).toEqual(['GOOD']);
    expect(await resolveSecrets(['has space'], path)).toEqual({});
  });
});

describe('where it lives', () => {
  it('honours AGBRTE_HOME, which is CLAUDE.md hazard 2', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agbrte-home-'));
    made.push(home);
    process.env['AGBRTE_HOME'] = home;
    // Two installations side by side is the case the variable exists for, and a
    // credentials file that ignored it would put one machine's keys under
    // another's directory.
    expect(secretsPath()).toBe(join(home, 'secrets.json'));
  });

  it('sits beside endpoints.json rather than in a workspace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agbrte-home-'));
    made.push(home);
    process.env['AGBRTE_HOME'] = home;
    await mkdir(home, { recursive: true });
    await setSecret('SEARCH_API_KEY', 'sk-live-abcdef', secretsPath());
    // §13's rule is about a file that *travels*. This one is in the machine's
    // install area (§5.1): no repository, no template, no workspace.
    const raw = await readFile(secretsPath(), 'utf8');
    expect(raw).toContain('SEARCH_API_KEY');
    expect(secretsPath()).not.toContain('.agbrte' + '/sessions');
  });
});

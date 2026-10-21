/**
 * Which build a host is running, as the host says it and as the app compares it
 * (`src/main/bundleStamp.ts`, §6.3).
 *
 * The test this replaces as the guard handed both sides the same hand-written
 * string — `running = '0.0.2-new'`, `shippingVersion: '0.0.2-new'` — and so could
 * not notice that in the real program the two were made by different code. They
 * were, for two months: the app compared `<version>+<digest>`, the local host
 * reported the build's bare `<version>`, and every local host showed an Update
 * button that pressing could not clear.
 *
 * So the first test here reads the **real build**. It needs `npm run build` to
 * have run, which every other build-stamp check in this suite already needs.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleDigest, readHostStamp, shippingStamp } from '../src/main/bundleStamp.js';

const VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string;

/** A build's own output, laid out the way `dist` is: `main/` beside `cli/`. */
function fakeBuild(banner: string): { dir: string; host: string } {
  const root = mkdtempSync(join(tmpdir(), 'agbrte-stamp-'));
  const dir = join(root, 'main');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'cli'), { recursive: true });
  const host = join(dir, 'agbrteHost.js');
  writeFileSync(host, `// agbrte-bundle: ${banner}\nconsole.log('host');\n`);
  writeFileSync(join(dir, 'agentHost.js'), "console.log('agent');\n");
  writeFileSync(join(root, 'cli', 'agbrte.js'), "console.log('cli');\n");
  return { dir, host };
}

describe('a host and the app agree on what it is running', () => {
  it('in the real build, the host reports exactly what the app compares against', () => {
    /*
     * The one that matters. A host started by the app runs `dist/main/
     * agbrteHost.js`; the app's shipping stamp is computed from the same
     * directory. If these differ, every local host is "out of date" the moment
     * it starts.
     */
    const host = readHostStamp(join(process.cwd(), 'dist', 'main', 'agbrteHost.js'));
    expect(host).toBe(shippingStamp(VERSION, join(process.cwd(), 'dist', 'main')));
    // And it is the full form, not the bare version the build writes.
    expect(host).toMatch(new RegExp(`^${VERSION.replace(/\./g, '\\.')}\\+[0-9a-f]{12}$`));
  });

  it('completes a bare build stamp with the digest of the files beside it', () => {
    const { dir, host } = fakeBuild('1.2.3');
    expect(readHostStamp(host)).toBe(`1.2.3+${bundleDigest(dir)}`);
  });

  it('still tells two builds of the same version apart', () => {
    /*
     * Why the digest exists at all (`8a77494`): nobody bumps the version between
     * builds, and a patched release can carry the same number, so a version-only
     * stamp would call yesterday's host current. Completing the bare stamp must
     * not lose that.
     */
    const { dir, host } = fakeBuild('1.2.3');
    const before = readHostStamp(host);
    writeFileSync(join(dir, 'agentHost.js'), "console.log('agent, patched');\n");
    expect(readHostStamp(host)).not.toBe(before);
  });

  it('reports an uploaded copy as it was stamped', () => {
    // `uploadHostBundle` writes the full stamp on the first line of the copy it
    // deploys. That string is the deploying client's own, and recomputing it
    // from the files beside the copy would be a different, wrong question.
    const { host } = fakeBuild('1.2.3+abcdef012345');
    expect(readHostStamp(host)).toBe('1.2.3+abcdef012345');
  });

  it('claims nothing about a file it cannot read or that carries no stamp', () => {
    // `null` reads as "cannot tell", which shows no button — never as stale.
    expect(readHostStamp(undefined)).toBeNull();
    expect(readHostStamp(join(tmpdir(), 'agbrte-no-such-file.js'))).toBeNull();
    const { host } = fakeBuild('1.2.3');
    writeFileSync(host, "console.log('unstamped');\n");
    expect(readHostStamp(host)).toBeNull();
  });
});

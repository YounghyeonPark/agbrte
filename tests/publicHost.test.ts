/**
 * What a host withdraws when strangers can reach it (§13, §7, §17 Q14).
 *
 * The rest of this repository assumes the person on the socket owns the machine.
 * `accessPolicy.ts` says so in its own first paragraph and is right to: a role is
 * a seatbelt when reaching the socket already proves ownership. A public demo is
 * the one deployment where that assumption is false, and these are the tests for
 * the things that stop being safe when it is.
 *
 * Every one of them is written so that it fails if the *default* changes. A
 * denylist that quietly gains a member, a tool added to the public set, a channel
 * that starts being answered — those are the regressions worth catching, and they
 * all look like nothing in a diff.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS, PUBLIC_TOOLS } from '../src/main/tools/index.js';
import { admitsChannel, refusalFor, PUBLIC_CHANNELS } from '../src/web/publicChannels.js';
import { isPublicHost, PUBLIC_HOST_ENV } from '../src/shared/publicHost.js';
import { CH } from '../src/shared/ipc/contract.js';

describe('the switch itself', () => {
  it('is off unless it is exactly on', () => {
    // The direction a mistake has to fall. A typo leaves a laptop working as a
    // laptop; the reverse default would publish a shell on a misread variable.
    expect(isPublicHost({})).toBe(false);
    expect(isPublicHost({ [PUBLIC_HOST_ENV]: '' })).toBe(false);
    expect(isPublicHost({ [PUBLIC_HOST_ENV]: '0' })).toBe(false);
    expect(isPublicHost({ [PUBLIC_HOST_ENV]: 'true' })).toBe(false);
    expect(isPublicHost({ [PUBLIC_HOST_ENV]: 'yes' })).toBe(false);
    expect(isPublicHost({ [PUBLIC_HOST_ENV]: '1' })).toBe(true);
  });
});

describe('the tools an agent may hold', () => {
  it('withholds the two that can leave the workspace', () => {
    const names = PUBLIC_TOOLS.map((t) => t.name);
    // `bash` runs a real shell with `cwd` in the workspace, and a shell can `cd`
    // — one `cat` reaches the endpoint file holding the demo's own credential.
    expect(names).not.toContain('bash');
    // `screenshot` renders a URL, which is a request made from inside whatever
    // network the server is on.
    expect(names).not.toContain('screenshot');
  });

  it('keeps the ones that are confined, so the demo can still do work', () => {
    const names = PUBLIC_TOOLS.map((t) => t.name);
    // Every path these take goes through `confine`. A demo that could not read
    // or edit a file would be the recording again, with more machinery.
    for (const kept of ['read', 'write', 'edit', 'glob', 'grep']) {
      expect(names).toContain(kept);
    }
  });

  /*
   * The regression this file exists for.
   *
   * `PUBLIC_TOOLS` is written out rather than filtered precisely so a tool added
   * to `DEFAULT_TOOLS` does not join a public host silently. This asserts the
   * consequence: anything new is absent until somebody adds it here on purpose,
   * and that decision is what this failing test asks them to make.
   */
  it('is a subset of the default set, never a superset', () => {
    const defaults = new Set(DEFAULT_TOOLS.map((t) => t.name));
    for (const tool of PUBLIC_TOOLS) expect(defaults.has(tool.name)).toBe(true);
    expect(PUBLIC_TOOLS.length).toBeLessThan(DEFAULT_TOOLS.length);
  });
});

describe('the channels a stranger may call', () => {
  it('refuses a terminal, which is a real pty on the serving machine', () => {
    for (const channel of [CH.shellOpen, CH.shellWrite, CH.shellResize, CH.shellClose]) {
      expect(admitsChannel(channel)).toBe(false);
    }
    expect(refusalFor(CH.shellOpen)).toMatch(/real shell/i);
  });

  it('refuses the machine itself — its screen, its processes, its folders', () => {
    for (const channel of [
      CH.captureGrab,
      CH.captureSources,
      CH.previewStart,
      CH.previewOpen,
      CH.hostsAdd,
      CH.hostsAddRemote,
      CH.hostsPickFolder,
      CH.hostsShutdown,
      CH.hostsUpdate,
      CH.hostsSetUp,
      CH.hostsInstallModel,
      CH.sessionsAttachMcp,
    ]) {
      expect(admitsChannel(channel)).toBe(false);
    }
  });

  it('still lets a visitor drive a session, because that is the product', () => {
    for (const channel of [
      CH.sessionsCreate,
      CH.sessionsSend,
      CH.sessionsSnapshot,
      CH.sessionsList,
      // The gate is the thing most worth showing, so answering it is allowed.
      // It is not a widening: a prompt only ever offers what the agent asked
      // for, and the agent can only ask for a confined tool.
      CH.permissionsPending,
      CH.permissionsRespond,
    ]) {
      expect(admitsChannel(channel)).toBe(true);
    }
  });

  /*
   * The allowlist property, asserted rather than described. An unknown channel
   * — one from a newer build, one somebody adds next month, one invented by a
   * caller — is refused. If this ever inverts, every future capability ships
   * publicly the day it is written.
   */
  it('refuses anything it has never heard of', () => {
    expect(admitsChannel('agbrte:something.invented')).toBe(false);
    expect(admitsChannel('')).toBe(false);
    expect(admitsChannel('__proto__')).toBe(false);
  });

  it('names every allowed channel, so the list cannot grow by accident', () => {
    // A count, deliberately. Adding a channel to a public host should require
    // changing a number in a test that says why the number is there.
    expect(PUBLIC_CHANNELS.size).toBe(30);
  });

  it('says what would work instead, rather than that the button is broken', () => {
    // Somebody who wanted a terminal should be sent to their own host, not to
    // the issue tracker.
    for (const channel of [CH.shellOpen, CH.captureGrab, CH.hostsAdd, CH.sessionsAttachMcp]) {
      expect(refusalFor(channel)).toMatch(/your own host/i);
    }
  });
});

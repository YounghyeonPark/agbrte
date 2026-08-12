/**
 * Who the host says is on the other end of a connection (DESIGN.md §6.4, §7).
 *
 * Separate from `identity.test.ts`, which is about workspace identity — a
 * different module with a different job that happens to share a noun.
 */

import { describe, expect, it } from 'vitest';
import { assertedIdentity, localIdentity } from '../src/host/identity.js';

/** Just the fields the function reads, so both platforms are testable on one. */
const info = (uid: number, username: string) => ({ uid, gid: uid, username }) as never;

describe('localIdentity', () => {
  /**
   * The module picks the uid over the login name for a stated reason: names get
   * reassigned, uids do not, and a log outlives the account that wrote it.
   *
   * On Windows there is no uid. `userInfo()` returns `-1`, so every actor on
   * every Windows machine was minted as `uid:-1` — one identity for every person
   * everywhere, and a number that identifies nobody. Windows over ssh is a
   * supported target, and this value is written into the append-only log as §13
   * attribution, so "who answered this prompt" had a single wrong answer.
   */
  it('gives different users different ids where the platform has no uid', () => {
    const ann = localIdentity(info(-1, 'ann'), 'box');
    const bob = localIdentity(info(-1, 'bob'), 'box');
    expect(ann.actor.id, 'every Windows user shares one actor id').not.toBe(bob.actor.id);
  });

  it('does not claim a uid it was never given', () => {
    // `uid:-1` is not a weaker claim than a name — it is a false one.
    expect(localIdentity(info(-1, 'ann'), 'box').actor.id).not.toContain('-1');
  });

  it('separates the same name on two machines', () => {
    // `Administrator` and `ubuntu` exist on a great many hosts. Without the
    // host in the id, two people on two machines merge into one actor.
    const here = localIdentity(info(-1, 'admin'), 'box-a');
    const there = localIdentity(info(-1, 'admin'), 'box-b');
    expect(here.actor.id).not.toBe(there.actor.id);
  });

  it('still prefers the uid on a platform that has one', () => {
    // Where the original reasoning holds it wins: a name can come back attached
    // to a different person, and a number cannot.
    expect(localIdentity(info(1001, 'ann'), 'box').actor.id).toBe('uid:1001');
  });

  it('is read-write, because the socket permission is what earned it', () => {
    expect(localIdentity(info(1001, 'ann'), 'box').ceiling).toBe('read-write');
    expect(localIdentity(info(-1, 'ann'), 'box').ceiling).toBe('read-write');
  });
});

describe('assertedIdentity', () => {
  it('is capped at read-only however it is asked', () => {
    // An unverified claim is no reason to refuse a viewer and never a reason to
    // accept a command. The cap lives in the function so a new source cannot
    // skip it.
    expect(assertedIdentity('phone').ceiling).toBe('read-only');
    expect(assertedIdentity('phone').actor.via).toBe('asserted');
  });
});

/**
 * What the picker says about a model, before it is chosen (DESIGN.md §3.3, §3.5).
 *
 * The incident these exist for is specific and recent: a user picked
 * `qwen3:0.6b` — whose probe answers `tools: 'none'` — then asked it four times
 * to search. Nothing happened, and nothing anywhere said why. §3.5's rule is
 * that a degradation nobody is told about reads as the feature being broken, and
 * this is that rule applied at the moment of choosing.
 *
 * Tested as a pure function rather than through a browser, because everything
 * worth getting wrong here is in the mapping. The three states that must never
 * collapse — probed, declared, unknown — are three strings, and a browser test
 * would assert that some words appeared while saying nothing about which of the
 * three they meant.
 */

import { describe, expect, it } from 'vitest';
import {
  contextBadge,
  formatWindow,
  imageBadge,
  panelBadges,
  reasoningBadge,
  rowBadges,
  toolBadge,
  toolWarning,
  worthChecking,
} from '../src/renderer/modelCapabilities.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import { COMMAND_SINCE, SESSION_PROTOCOL_VERSION } from '@shared/host/sessionProtocol.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { InstanceId, LineageId, ModelCapabilityHint } from '@shared/types/index.js';

const hint = (over: Partial<ModelCapabilityHint> = {}): ModelCapabilityHint => ({
  endpointId: 'local',
  modelId: 'qwen3:0.6b',
  ...over,
});

describe('unknown is its own answer', () => {
  it('renders unknown for a model nothing is known about — not absent, not no', () => {
    // The rule: "never claim a capability that was not probed". Its mirror
    // matters just as much — an unchecked capability shown as a missing one
    // libels every model on a server that does not self-describe.
    const badge = toolBadge(undefined);
    expect(badge.tone).toBe('unknown');
    expect(badge.text).toContain('unknown');
    expect(badge.text).not.toBe('no tools');
  });

  it('gives every slot a word rather than leaving a gap', () => {
    // A row that simply omits what it does not know reads as "nothing to
    // report", which is the reading this feature exists to prevent.
    for (const badge of panelBadges(undefined)) {
      expect(badge.tone).toBe('unknown');
      expect(badge.text).not.toBe('');
    }
  });

  it('does not treat a hint that established nothing as a set of noes', () => {
    // A host answered, and could tell us nothing. Same rendering as never
    // having asked — because it is the same fact.
    const badges = panelBadges(hint());
    expect(badges.find((b) => b.key === 'tools')?.text).toContain('unknown');
    expect(badges.find((b) => b.key === 'context')?.text).toContain('unknown');
  });
});

describe('a declared capability is not a demonstrated one (§3.3)', () => {
  it('marks a server-declared yes as declared, and keeps it out of the plain tone', () => {
    const badge = toolBadge(hint({ tools: { value: 'native', from: 'self-described' } }));
    expect(badge.text).toBe('tools: declared');
    // Not `plain`: a plain badge is the one a reader trusts, and small models
    // routinely declare tool support and then fail to produce a call.
    expect(badge.tone).toBe('unknown');
  });

  it('states a probed yes plainly', () => {
    const badge = toolBadge(hint({ tools: { value: 'native', from: 'probed' } }));
    expect(badge.text).toBe('tools');
    expect(badge.tone).toBe('plain');
  });

  it('says how a claim was established, in the long form', () => {
    expect(toolBadge(hint({ tools: { value: 'native', from: 'probed' } })).title).toContain(
      'running the model',
    );
    expect(
      toolBadge(hint({ tools: { value: 'native', from: 'self-described' } })).title,
    ).toContain('reported by the server');
  });

  it('is still worth checking while the only claim is a declaration', () => {
    expect(worthChecking(undefined)).toBe(true);
    expect(worthChecking(hint({ tools: { value: 'native', from: 'self-described' } }))).toBe(true);
    expect(worthChecking(hint({ tools: { value: 'none', from: 'probed' } }))).toBe(false);
  });
});

describe('the incident: a model that cannot call tools', () => {
  it('is marked, loudly, in the list', () => {
    const badge = toolBadge(hint({ tools: { value: 'none', from: 'probed' } }));
    expect(badge.text).toBe('no tools');
    expect(badge.tone).toBe('warn');
  });

  it('says the consequence, not just the fact', () => {
    // "no tools" is a label. What was missing that morning was the sentence:
    // with our own harness, such an agent can only chat.
    const warning = toolWarning(hint({ tools: { value: 'none', from: 'probed' } }));
    expect(warning).toContain('only chat');
    expect(warning).toContain('search');
  });

  it('distinguishes a probed refusal from a server that lists no tool support', () => {
    const probed = toolWarning(hint({ tools: { value: 'none', from: 'probed' } }));
    const declared = toolWarning(hint({ tools: { value: 'none', from: 'self-described' } }));
    expect(probed).not.toBe(declared);
    expect(declared).toContain('endpoint reports no tool support');
  });

  it('says nothing where there is nothing to warn about', () => {
    expect(toolWarning(undefined)).toBeNull();
    expect(toolWarning(hint({ tools: { value: 'native', from: 'probed' } }))).toBeNull();
  });

  it('marks a text-protocol model as tool-capable, because it is', () => {
    // §3.5: no native tool calling is not the same as no tool calling. The
    // codec renders the suite as instructions and parses the calls back out.
    const badge = toolBadge(hint({ tools: { value: 'text-protocol', from: 'probed' } }));
    expect(badge.tone).toBe('plain');
    expect(badge.text).toBe('tools: text');
  });
});

describe('context window', () => {
  it('shows a reported window as a fact', () => {
    const badge = contextBadge(hint({ contextWindow: { value: 40_960, from: 'self-described' } }));
    expect(badge.text).toBe('40k ctx');
    expect(badge.tone).toBe('plain');
  });

  it('shows an assumed floor as an assumption', () => {
    // The number is real — the harness sizes against it — but the server never
    // said it, and a picker showing it plainly would be inventing a fact.
    const badge = contextBadge(hint({ contextWindow: { value: 8_192, from: 'configured' } }));
    expect(badge.tone).toBe('unknown');
    expect(badge.title).toContain('assumed');
  });

  it('quotes windows in thousands', () => {
    expect(formatWindow(131_072)).toBe('128k');
    expect(formatWindow(8_192)).toBe('8k');
    expect(formatWindow(512)).toBe('512');
  });
});

describe('image input describes what Agbrte will do, not what the weights could', () => {
  it('reads as a downgrade, because that is what happens to the pixels', () => {
    const badge = imageBadge(hint({ imageInput: { value: false, from: 'configured' } }));
    expect(badge.text).toBe('no images');
    expect(badge.tone).toBe('warn');
    expect(badge.title).toContain('line of text');
  });
});

describe('reasoning control', () => {
  it('says an effort setting is available where the server reports thinking', () => {
    const badge = reasoningBadge(hint({ reasoningControl: { value: 'effort', from: 'self-described' } }));
    expect(badge.text).toContain('effort');
    expect(badge.tone).toBe('plain');
  });

  it('reports its absence plainly rather than as a warning', () => {
    // Nothing is broken about a model that does not think out loud, and
    // colouring it as a limit would make most of a list look wrong.
    expect(reasoningBadge(hint({ reasoningControl: { value: 'none', from: 'self-described' } })).tone).toBe(
      'plain',
    );
  });
});

/**
 * An older host costs the badges, not the connection (§17 Q16).
 *
 * The degradation has to land on *today's behaviour* — a list of model names
 * with nothing claimed about them — rather than on an error, and certainly not
 * on a row that reads as though the model were checked and found wanting. A
 * detached host outlives the app that spawned it, so this is the ordinary case
 * an hour after an update, not an edge one.
 */
describe('a host that predates the command', () => {
  it('declares when models.capabilities arrived', () => {
    expect(COMMAND_SINCE['models.capabilities']).toBe(14);
    expect(SESSION_PROTOCOL_VERSION).toBeGreaterThanOrEqual(14);
  });

  it('says which command it lacks, and stays good for everything else', async () => {
    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const client = new HostConnection({ channel: main, client: 'test' });

    host.onMessage((command) => {
      if (command.t !== 'hello') return;
      host.post({
        t: 'welcome',
        id: command.id,
        role: 'read-write',
        identity: {
          instanceId: 'i' as InstanceId,
          lineageId: 'l' as LineageId,
          workspaceRoot: '/w',
          runtimes: [],
          pid: 1,
          // The version shipped one change ago: it has `models.list` and not this.
          protocol: SESSION_PROTOCOL_VERSION - 1,
          minProtocol: 1,
        },
      } as SessionMessage);
    });

    await client.ready;
    expect(client.supports('models.capabilities')).toBe(false);
    await expect(client.modelCapabilities('local', 'qwen3:0.6b')).rejects.toThrow(/needs v14/);
    // The list still works, which is what "one feature, not the connection"
    // means — and a list with no capabilities field is exactly the screen that
    // shipped before this change.
    expect(client.supports('models.list')).toBe(true);
    client.disconnect();
  });

  it('renders a list with no capability field as unknown, not as a wall of noes', () => {
    // What a v13 host's `models.list` produces: names, and nothing claimed.
    const badges = rowBadges(undefined);
    expect(badges.every((b) => b.tone === 'unknown')).toBe(true);
    expect(badges.map((b) => b.text).join(' ')).not.toContain('no tools');
  });
});

describe('what fits on a row', () => {
  it('carries the two claims that decide the job', () => {
    expect(rowBadges(undefined).map((b) => b.key)).toEqual(['tools', 'context']);
  });

  it('keeps the rest for the entry somebody actually landed on', () => {
    // §3.10's argument, applied here: `no images` is identical on every
    // openai-compatible row, and a label that is always the same teaches people
    // to stop reading labels.
    expect(panelBadges(undefined).map((b) => b.key)).toEqual([
      'tools',
      'context',
      'image',
      'reasoning',
    ]);
  });
});

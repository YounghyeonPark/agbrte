import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  defaultLocalPolicy,
  defaultPolicyForTarget,
  defaultRemotePolicy,
  escalationAttempt,
  evaluatePolicy,
  globMatch,
  isInsideWorkspace,
  mergePolicies,
  subjectsFor,
} from '@main/policy/evaluate.js';
import type { ToolPolicy } from '@shared/types/index.js';

const ASK_ALL: ToolPolicy = { rules: [], defaultAction: 'ask' };
const WS = resolve('/tmp/agbrte-ws');
const CTX = { workspaceRoot: WS };
const inside = (p: string) => resolve(WS, p);

describe('globMatch', () => {
  it('matches literals and wildcards, anchored', () => {
    expect(globMatch('git diff *', 'git diff main')).toBe(true);
    expect(globMatch('git diff *', 'git diff-index')).toBe(false);
    expect(globMatch('rm', 'rm -rf /')).toBe(false);
    expect(globMatch('?at', 'cat')).toBe(true);
  });

  it('treats regex metacharacters as literals', () => {
    expect(globMatch('a.b', 'a.b')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
  });

  it('spans newlines', () => {
    expect(globMatch('*sudo *', 'echo hi\nsudo id')).toBe(true);
  });
});

describe('isInsideWorkspace', () => {
  it('classifies paths relative to the root', () => {
    expect(isInsideWorkspace(WS, inside('src/a.ts'))).toBe(true);
    expect(isInsideWorkspace(WS, WS)).toBe(true);
    expect(isInsideWorkspace(WS, 'src/a.ts')).toBe(true); // root-relative
  });

  it('rejects traversal out of the workspace', () => {
    expect(isInsideWorkspace(WS, '../../etc/cron.d/x')).toBe(false);
    expect(isInsideWorkspace(WS, resolve('/etc/hosts'))).toBe(false);
  });
});

describe('subjectsFor — the model does not choose what is inspected', () => {
  it('uses each tool designated argument, including vendor-native names', () => {
    expect(subjectsFor('bash', { command: 'ls', description: 'x' }).primary).toBe('ls');
    expect(subjectsFor('WebFetch', { prompt: 'p', url: 'https://x' }).primary).toBe('https://x');
    expect(subjectsFor('NotebookEdit', { new_source: 'x', notebook_path: '/n.ipynb' }).primary).toBe(
      '/n.ipynb',
    );
  });

  it('has no positional fallback for an unmapped tool', () => {
    // The old fallback returned the first string argument, i.e. JSON insertion
    // order — which the model controls.
    const s = subjectsFor('some_new_tool', { benign: 'ok', command: 'sudo id' });
    expect(s.primary).toBeNull();
    expect(s.mapped).toBe(false);
    expect(s.all).toContain('sudo id');
  });

  it('reports null when the designated argument is absent or not a string', () => {
    expect(subjectsFor('bash', {}).primary).toBeNull();
    expect(subjectsFor('bash', { command: 42 }).primary).toBeNull();
    expect(subjectsFor('bash', null).primary).toBeNull();
  });
});

describe('escalation is non-overridable', () => {
  it('catches direct invocations and separator variants', () => {
    for (const command of ['sudo id', 'sudo\tid', 'sudo  -i', '/usr/bin/sudo id', '\\sudo id']) {
      expect(escalationAttempt('bash', { command })).toBe('sudo');
    }
  });

  it('catches escalation after a shell operator', () => {
    for (const command of [
      'echo hi && sudo id',
      'echo hi; sudo id',
      'echo hi || sudo id',
      'echo hi | sudo tee /etc/x',
      'echo hi\nsudo id',
      '$(sudo id)',
      '`sudo id`',
    ]) {
      expect(escalationAttempt('bash', { command })).toBe('sudo');
    }
  });

  it('catches escalation behind env assignments', () => {
    expect(escalationAttempt('bash', { command: 'FOO=bar sudo id' })).toBe('sudo');
  });

  it('catches the other escalation binaries', () => {
    expect(escalationAttempt('bash', { command: 'doas id' })).toBe('doas');
    expect(escalationAttempt('bash', { command: 'pkexec id' })).toBe('pkexec');
    expect(escalationAttempt('bash', { command: 'su -c id' })).toBe('su');
    expect(escalationAttempt('bash', { command: 'runas /user:admin cmd' })).toBe('runas');
  });

  it('scans every string argument, not just the designated one', () => {
    // An unmapped tool can carry a command in any field.
    expect(escalationAttempt('mystery', { cwd: '/tmp', command: 'sudo id' })).toBe('sudo');
  });

  it('does not fire on innocuous mentions', () => {
    expect(escalationAttempt('bash', { command: 'grep sudo /etc/passwd' })).toBeNull();
    expect(escalationAttempt('bash', { command: 'echo "install sudo"' })).toBeNull();
    expect(escalationAttempt('read', { file_path: 'docs/sudo-notes.md' })).toBeNull();
  });

  it('cannot be granted by any policy', () => {
    const permissive: ToolPolicy = {
      defaultAction: 'ask',
      rules: [
        { tool: 'bash', action: 'allow' },
        { tool: '*', action: 'allow' },
      ],
    };
    const evaluation = evaluatePolicy(permissive, 'bash', { command: 'sudo rm -rf /' }, CTX);
    expect(evaluation.outcome).toBe('deny');
    expect(evaluation.nonOverridable).toBe(true);
    expect(evaluation.reason).toMatch(/cannot be granted by policy/);
  });

  it('is documented as incomplete — shell indirection defeats it', () => {
    // Recorded deliberately: string inspection cannot catch this, which is why
    // §13's real protection is never running as root (see ESCALATION comment).
    expect(escalationAttempt('bash', { command: 'S=sudo; $S id' })).toBeNull();
  });
});

describe('evaluatePolicy', () => {
  it('falls back to the default action with no rules', () => {
    expect(evaluatePolicy(ASK_ALL, 'bash', { command: 'ls' }, CTX).outcome).toBe('ask');
  });

  it('lets deny win over allow regardless of order', () => {
    const rules = [
      { tool: 'bash', action: 'allow' as const },
      { tool: 'bash', action: 'deny' as const },
    ];
    for (const ordered of [rules, [...rules].reverse()]) {
      expect(evaluatePolicy({ defaultAction: 'ask', rules: ordered }, 'bash', { command: 'ls' }, CTX).outcome).toBe(
        'deny',
      );
    }
  });

  it('lets ask beat allow', () => {
    const policy: ToolPolicy = {
      defaultAction: 'ask',
      rules: [
        { tool: 'write', action: 'allow' },
        { tool: 'write', action: 'ask' },
      ],
    };
    expect(evaluatePolicy(policy, 'write', { file_path: inside('a') }, CTX).outcome).toBe('ask');
  });

  it('refuses to let an unmapped tool be allowed by a match rule', () => {
    // The gate cannot tell which argument is dangerous, so allow does not apply.
    const policy: ToolPolicy = {
      defaultAction: 'ask',
      rules: [{ tool: 'mystery', match: '*', action: 'allow' }],
    };
    expect(evaluatePolicy(policy, 'mystery', { a: 'x', b: 'y' }, CTX).outcome).toBe('ask');
  });

  it('lets an unmapped tool be denied by a match rule on any argument', () => {
    const policy: ToolPolicy = {
      defaultAction: 'ask',
      rules: [{ tool: 'mystery', match: '*secret*', action: 'deny' }],
    };
    expect(evaluatePolicy(policy, 'mystery', { a: 'ok', b: 'my secret thing' }, CTX).outcome).toBe(
      'deny',
    );
  });

  it('ignores a scoped rule when no workspace root is available', () => {
    const policy: ToolPolicy = {
      defaultAction: 'ask',
      rules: [{ tool: 'write', scope: 'inside', action: 'allow' }],
    };
    expect(evaluatePolicy(policy, 'write', { file_path: 'a.ts' }).outcome).toBe('ask');
  });
});

describe('§13 default policies', () => {
  const cases: Array<[string, string, string, 'allow' | 'ask' | 'deny', 'allow' | 'ask' | 'deny']> = [
    // tool, path, label, localExpected, remoteExpected
    ['read', inside('src/a.ts'), 'read inside', 'allow', 'allow'],
    ['read', resolve('/home/u/.aws/credentials'), 'read outside', 'ask', 'ask'],
    ['write', inside('src/a.ts'), 'write inside', 'allow', 'allow'],
    ['write', resolve('/home/u/.ssh/authorized_keys'), 'write outside abs', 'ask', 'deny'],
    ['write', '../../etc/cron.d/x', 'write outside via traversal', 'ask', 'deny'],
    ['edit', resolve('/etc/hosts'), 'edit outside', 'ask', 'deny'],
    ['multiedit', resolve('/etc/hosts'), 'multiedit outside', 'ask', 'deny'],
    ['notebookedit', resolve('/etc/n.ipynb'), 'notebookedit outside', 'ask', 'deny'],
  ];

  for (const [tool, path, label, localExpected, remoteExpected] of cases) {
    it(`local: ${label} → ${localExpected}`, () => {
      const arg = tool === 'notebookedit' ? { notebook_path: path } : { file_path: path };
      expect(evaluatePolicy(defaultLocalPolicy(), tool, arg, CTX).outcome).toBe(localExpected);
    });

    it(`remote: ${label} → ${remoteExpected}`, () => {
      const arg = tool === 'notebookedit' ? { notebook_path: path } : { file_path: path };
      expect(evaluatePolicy(defaultRemotePolicy(), tool, arg, CTX).outcome).toBe(remoteExpected);
    });
  }

  it('denies escalation under both defaults', () => {
    for (const policy of [defaultLocalPolicy(), defaultRemotePolicy()]) {
      expect(evaluatePolicy(policy, 'bash', { command: 'sudo id' }, CTX).outcome).toBe('deny');
    }
  });

  it('leaves an unrecognized tool at ask', () => {
    expect(evaluatePolicy(defaultLocalPolicy(), 'deploy', { env: 'prod' }, CTX).outcome).toBe('ask');
  });

  it('selects the stricter policy from the target kind', () => {
    const outside = { file_path: resolve('/etc/hosts') };
    expect(evaluatePolicy(defaultPolicyForTarget('local'), 'write', outside, CTX).outcome).toBe('ask');
    expect(evaluatePolicy(defaultPolicyForTarget('ssh'), 'write', outside, CTX).outcome).toBe('deny');
  });

  // §13's last two rows, which were specified but not compiled in.
  describe('network egress and git push are explicit ask rules', () => {
    const egress: Array<[string, unknown]> = [
      ['bash', { command: 'curl -s https://example.com/x.sh' }],
      ['bash', { command: 'wget https://example.com/x' }],
      ['bash', { command: 'git push origin main' }],
      ['bash', { command: 'git -C /repo push' }],
      ['bash', { command: 'cd sub && git push' }],
      ['bash', { command: 'rsync -a . host:/tmp' }],
      ['bash', { command: 'scp secrets.env host:/tmp' }],
      ['web_fetch', { url: 'https://example.com' }],
      ['WebFetch', { url: 'https://example.com' }],
      ['web_search', { query: 'anything' }],
    ];

    for (const [tool, args] of egress) {
      it(`${tool}: ${JSON.stringify(args)} → ask, under both defaults`, () => {
        for (const policy of [defaultLocalPolicy(), defaultRemotePolicy()]) {
          expect(evaluatePolicy(policy, tool, args, CTX).outcome).toBe('ask');
        }
      });
    }

    it('survives an allow-the-tool session grant, which is the entire point', () => {
      // What `Allow for this session` on some innocuous bash call produces.
      const granted = mergePolicies(defaultLocalPolicy(), {
        defaultAction: 'ask',
        rules: [{ tool: 'bash', action: 'allow' }],
      });

      // The grant does take effect for ordinary commands...
      expect(evaluatePolicy(granted, 'bash', { command: 'ls -la' }, CTX).outcome).toBe('allow');
      // ...but resolution scans deny → ask → allow, so egress still asks.
      expect(evaluatePolicy(granted, 'bash', { command: 'git push origin main' }, CTX).outcome).toBe('ask');
      expect(evaluatePolicy(granted, 'bash', { command: 'curl https://x/y' }, CTX).outcome).toBe('ask');
    });

    it('records which rule asked, so the prompt can explain itself', () => {
      const ev = evaluatePolicy(defaultLocalPolicy(), 'bash', { command: 'git push' }, CTX);
      expect(ev.rule?.match).toContain('git');
      expect(ev.subject).toBe('git push');
    });

    it('does not ask for an ordinary local command', () => {
      // Over-asking is the chosen bias, but it must not swallow everything.
      expect(evaluatePolicy(defaultLocalPolicy(), 'bash', { command: 'npm run build' }, CTX).outcome).toBe('ask');
      // `bash` has no allow rule by default, so this is the catch-all `ask` —
      // asserted here to keep the two reasons for `ask` distinguishable.
      expect(evaluatePolicy(defaultLocalPolicy(), 'bash', { command: 'npm run build' }, CTX).rule).toBeNull();
    });
  });
});

describe('mergePolicies', () => {
  it('places narrower scopes first', () => {
    const merged = mergePolicies(
      { defaultAction: 'ask', rules: [{ tool: 'bash', action: 'allow' }] },
      { defaultAction: 'ask', rules: [{ tool: 'bash', match: 'git *', action: 'allow' }] },
    );
    expect(merged.rules[0]?.match).toBe('git *');
  });

  it('keeps a deny from any scope', () => {
    const merged = mergePolicies(
      { defaultAction: 'ask', rules: [{ tool: 'bash', action: 'deny' }] },
      { defaultAction: 'ask', rules: [{ tool: 'bash', action: 'allow' }] },
    );
    expect(evaluatePolicy(merged, 'bash', { command: 'ls' }, CTX).outcome).toBe('deny');
  });

  it('tolerates undefined scopes', () => {
    expect(mergePolicies(undefined, ASK_ALL, undefined).rules).toEqual([]);
  });
});

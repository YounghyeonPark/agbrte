/**
 * A headless driver for Gilmok's core, so the machinery can be exercised before
 * the Electron shell exists.
 *
 * This is not the product — it is the smallest thing that runs a real session
 * against a real workspace with a real model, prints the events, and answers
 * permission prompts at the terminal.
 *
 *   npm run gilmok -- --workspace ./sandbox --goal "add a README" "Write a README.md"
 *   npm run gilmok -- --inspect <sessionId> --workspace ./sandbox
 */

import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { GilmokHarnessRuntime, GILMOK_HARNESS_RUNTIME_ID } from '@main/runtime/runtimes/gilmokHarness.js';
import {
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@main/runtime/providers/openaiCompatible.js';
import { openWorkspace } from '@main/store/identity.js';
import { SessionStore } from '@main/store/sessionStore.js';
import { checklistProgress, type ModelEndpoint, type SessionId } from '@shared/types/index.js';

interface Args {
  workspace: string;
  goal: string;
  model: string;
  baseUrl: string;
  prompt: string;
  inspect: string | null;
  autoApprove: boolean;
}

/** Flags that consume the next argument. Everything else is a boolean. */
const VALUE_FLAGS = new Set(['--workspace', '--goal', '--model', '--base-url', '--inspect']);

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next !== undefined) values.set(arg, next);
      i += 1; // consume the value, so it is never mistaken for the prompt
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  const get = (flag: string): string | null => values.get(flag) ?? null;

  return {
    workspace: resolve(get('--workspace') ?? './sandbox'),
    goal: get('--goal') ?? 'explore the workspace',
    model: get('--model') ?? 'qwen2.5:7b',
    baseUrl: get('--base-url') ?? 'http://127.0.0.1:11434/v1',
    prompt: positional.join(' ').trim(),
    inspect: get('--inspect'),
    autoApprove: argv.includes('--yes'),
  };
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.inspect) return inspect(args);

  if (!args.prompt) {
    console.error('Usage: npm run gilmok -- --workspace <dir> --goal "<goal>" "<prompt>"');
    console.error('       npm run gilmok -- --workspace <dir> --inspect <sessionId>');
    process.exitCode = 1;
    return;
  }

  const identity = await openWorkspace(args.workspace);
  console.log(c.dim(`workspace  ${args.workspace}  (${identity.origin})`));
  console.log(c.dim(`lineage    ${identity.lineageId}`));

  const endpoint: ModelEndpoint = {
    endpointId: 'local-ollama',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: args.baseUrl,
    auth: { kind: 'none' },
    // Nothing leaves the machine, which is the honest answer for a local server.
    locality: 'app-local',
    dataHandling: { provider: 'local', retentionNote: 'nothing transmitted off-machine' },
  };

  const provider = new OpenAiCompatibleProvider();
  const registry = new RuntimeRegistry();
  registry.register(new GilmokHarnessRuntime({ provider, endpointFor: () => endpoint }), {
    label: `GilmokHarness → ${args.model}`,
    requiresModel: true,
  });

  const sm = new SessionManager({
    registry,
    workspaceRoot: args.workspace,
    instanceId: identity.instanceId,
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  sm.on('permission', (req) => {
    void (async () => {
      const argsPreview = JSON.stringify(req.args).slice(0, 300);
      console.log(`\n${c.yellow('◆ permission')} ${c.bold(req.tool)} ${c.dim(argsPreview)}`);
      if (args.autoApprove) {
        console.log(c.dim('  auto-approved (--yes)'));
        await sm.respondPermission(req.requestId, { result: 'allow', scope: 'session' });
        return;
      }
      const answer = (await rl.question('  allow? [y]es / [a]lways this tool / [n]o: ')).trim().toLowerCase();
      if (answer === 'y') await sm.respondPermission(req.requestId, { result: 'allow', scope: 'once' });
      else if (answer === 'a') await sm.respondPermission(req.requestId, { result: 'allow', scope: 'session' });
      else await sm.respondPermission(req.requestId, { result: 'deny', reason: 'user declined' });
    })();
  });

  sm.on('state', (_id, to, from) => console.log(c.dim(`  ${from} → ${to}`)));
  sm.on('degraded', (_id, _agent, why) => console.log(c.yellow(`  degraded: ${why}`)));
  sm.on('resume-rejected', () => console.log(c.dim('  native resume rejected, rehydrating')));

  const session = await sm.createSession({ title: args.prompt.slice(0, 60), goal: args.goal });
  console.log(c.dim(`session    ${session.sessionId}`));

  console.log(c.dim(`probing    ${args.model} …`));
  let agent;
  try {
    agent = await sm.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: GILMOK_HARNESS_RUNTIME_ID,
      model: { providerId: OPENAI_COMPATIBLE_PROVIDER_ID, modelId: args.model },
    });
  } catch (err) {
    console.error(c.red(`\nagent refused: ${(err as Error).message}`));
    rl.close();
    process.exitCode = 1;
    return;
  }

  const caps = agent.resolvedCapabilities;
  console.log(
    c.dim(
      `capability tools=${caps.tools} schema=${caps.schemaProfile} ` +
        `ctx=${caps.contextWindow} parallel=${caps.parallelToolCalls} fidelity=${caps.permissionFidelity}`,
    ),
  );
  if (caps.tools === 'none') {
    console.log(c.yellow('  this model showed no usable tool calling — it can only answer in text'));
  }

  console.log(`\n${c.cyan('▸')} ${args.prompt}\n`);

  const seen = new Set<number>();
  const tail = setInterval(() => {
    void (async () => {
      for (const ev of await sm.events(session.sessionId)) {
        if (seen.has(ev.seq)) continue;
        seen.add(ev.seq);
        render(ev);
      }
    })();
  }, 150);

  try {
    await sm.send(session.sessionId, agent.agentId, {
      content: [{ type: 'text', text: args.prompt }],
    });
  } finally {
    clearInterval(tail);
    for (const ev of await sm.events(session.sessionId)) {
      if (!seen.has(ev.seq)) render(ev);
    }
  }

  const projection = await sm.projection(session.sessionId);
  const progress = checklistProgress(projection);
  console.log(`\n${c.bold('— session complete —')}`);
  console.log(`  state       ${projection.state}`);
  console.log(`  events      ${projection.lastSeq}`);
  console.log(`  tools       ${projection.stats.toolCalls} calls, ${projection.stats.toolErrors} errors`);
  console.log(`  decisions   ${projection.stats.permissionPrompts} logged, ${projection.stats.permissionDenials} denied`);
  console.log(`  tokens      ${projection.usage.inputTokens} in / ${projection.usage.outputTokens} out`);
  console.log(`  cost        ${projection.usage.cost === 'unknown' ? 'not visible to Gilmok' : `$${projection.usage.cost}`}`);
  if (progress.total > 0) console.log(`  checklist   ${progress.done}/${progress.total}`);
  console.log(
    c.dim(`\n  transcript  ${args.workspace}/.devagents/sessions/${session.sessionId}/events.jsonl`),
  );
  console.log(c.dim(`  replay      npm run gilmok -- --workspace ${args.workspace} --inspect ${session.sessionId}`));

  rl.close();
}

function render(ev: Awaited<ReturnType<SessionManager['events']>>[number]): void {
  switch (ev.type) {
    case 'agent.text':
      console.log(ev.text);
      break;
    case 'agent.tool_use':
      console.log(c.cyan(`  ⚙ ${ev.tool}`) + c.dim(` ${JSON.stringify(ev.args).slice(0, 160)}`));
      break;
    case 'agent.tool_result':
      console.log(`  ${ev.ok ? c.green('✓') : c.red('✗')} ${c.dim(ev.summary)}`);
      break;
    case 'permission.decided':
      console.log(c.dim(`  · gate ${ev.decision.result} via ${ev.via}`));
      break;
    case 'agent.started':
      console.log(c.dim(`  · resume mode: ${ev.resumeMode}`));
      break;
    case 'agent.stopped':
      console.log(c.dim(`  · stopped: ${ev.stop.kind}`));
      break;
    default:
      break;
  }
}

/**
 * Reopen a session's log from disk and fold it.
 *
 * This is the persistence claim, demonstrated: the store is reopened in a fresh
 * process and the transcript is intact. Note `SessionManager` cannot yet
 * *reattach* to an existing session — only the store can be reopened — which is
 * a real Phase 1 gap rather than a limitation of the format.
 */
async function inspect(args: Args): Promise<void> {
  const { store, truncatedBytes } = await SessionStore.open(
    args.workspace,
    args.inspect as SessionId,
  );
  const meta = await store.readMeta();
  const { projection, fromCheckpointSeq, replayed } = await store.load();

  console.log(c.bold(`\n${meta.title}`));
  console.log(c.dim(`  goal        ${meta.goal}`));
  console.log(c.dim(`  created     ${meta.createdAt}`));
  console.log(`  state       ${projection.state}`);
  console.log(`  events      ${projection.lastSeq}`);
  console.log(`  loaded      ${fromCheckpointSeq === null ? 'full replay' : `checkpoint ${fromCheckpointSeq} + ${replayed}`}`);
  if (truncatedBytes > 0) console.log(c.yellow(`  recovered   discarded ${truncatedBytes}B torn tail`));
  if (projection.skippedLines > 0) console.log(c.red(`  corruption  ${projection.skippedLines} unparseable line(s)`));

  console.log(c.dim('\n  agents'));
  for (const a of projection.agents) {
    console.log(`    ${a.agentId.slice(0, 8)}  ${a.role}  ${a.runtimeId}  ${a.model?.modelId ?? '—'}  ${a.permissionFidelity}`);
  }

  console.log(c.dim('\n  transcript'));
  for (const ev of await store.readEvents()) render(ev);
}

main().catch((err) => {
  console.error(c.red(`\nfatal: ${(err as Error).stack ?? String(err)}`));
  process.exitCode = 1;
});

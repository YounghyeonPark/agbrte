#!/usr/bin/env node
/**
 * A stand-in agent CLI that speaks Claude Code's `stream-json` shape.
 *
 * This exists so `agent-cli-stdio` can be proven against a **real subprocess**:
 * real argv, real pipes with real chunk boundaries, real exit codes, and a real
 * second process for the resume half of deny-ask-resume. A mocked spawn would
 * have tested the adapter's control flow while quietly assuming away the two
 * things that actually break text protocols — framing and process lifetime.
 *
 * What it deliberately does not do is guess at the vendor's behaviour beyond
 * the record shapes: it is a protocol fixture, not a model.
 *
 * Modes (`--mode`):
 *   plain       text, then a successful result with usage
 *   deny-once   asks for a tool; refuses it unless it appears in --allowedTools
 *   split       one record written in many tiny writes, to break naive framing
 *   noise       protocol interleaved with non-JSON banner lines
 *   crash       exits non-zero having printed nothing resembling a result
 *   missing     exits imitating a binary that is not installed
 */

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const mode = flag('--mode') ?? 'plain';
const resume = flag('--resume');
const allowed = (flag('--allowedTools') ?? '').split(',').filter(Boolean);
const sessionId = resume ?? 'sess-fake-1';

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

const init = () => write({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake' });
const say = (text) =>
  write({
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
const result = (inputTokens, outputTokens) =>
  write({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    total_cost_usd: 0.003,
  });

/** True when a term like `Read` or `Read(a.ts)` covers this tool. */
const isAllowed = (tool) => allowed.some((t) => t === tool || t.startsWith(`${tool}(`));

switch (mode) {
  case 'plain': {
    init();
    say('hello');
    result(12, 7);
    break;
  }

  case 'deny-once': {
    init();
    const tool = 'Read';
    const id = 'tu-1';
    say(resume ? 'resumed' : 'starting');
    write({
      type: 'assistant',
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: tool, input: { file_path: 'a.ts' } }],
      },
    });
    write({
      type: 'user',
      session_id: sessionId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            is_error: !isAllowed(tool),
            content: isAllowed(tool)
              ? 'export const a = 1'
              : `Claude requested permissions to use ${tool}, but you haven't granted it yet.`,
          },
        ],
      },
    });
    // A denial does not end the run badly — the agent is told no and wraps up.
    // Reporting it as an error would have hidden the case this fixture is for.
    result(12, 7);
    break;
  }

  case 'split': {
    // One record, handed over in pieces that fall inside strings and between
    // braces, then the newline last.
    const record = JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'chunked across writes' }] },
    });
    init();
    for (let i = 0; i < record.length; i += 7) process.stdout.write(record.slice(i, i + 7));
    process.stdout.write('\n');
    result(12, 7);
    break;
  }

  case 'noise': {
    process.stdout.write('npm notice New major version available\n');
    init();
    process.stdout.write('(node:1) DeprecationWarning: something\n');
    say('hello');
    result(12, 7);
    break;
  }

  case 'crash': {
    init();
    say('got partway');
    process.stderr.write('fake-cli: exploded\n');
    process.exit(1);
    break;
  }

  case 'missing': {
    process.stderr.write("spawn claude ENOENT: 'claude' is not recognized\n");
    process.exit(127);
    break;
  }

  default:
    process.stderr.write(`fake-cli: unknown mode ${mode}\n`);
    process.exit(2);
}

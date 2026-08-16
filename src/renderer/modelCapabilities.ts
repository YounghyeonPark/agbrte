/**
 * What a model can do, in the few words a picker has room for (§3.3, §3.5).
 *
 * This exists because of one real morning: a user chose `qwen3:0.6b`, whose
 * probe answers `tools: 'none'`, and asked it four times to search. Nothing
 * happened, and nothing anywhere said why — under `AgbrteHarness` a model that
 * cannot call tools can only chat. §3.5's rule is that a degradation nobody is
 * told about reads as the feature being broken, and the cheapest moment to tell
 * somebody is before they pick.
 *
 * ## Three rules, and they are the whole file
 *
 * **Unknown renders as unknown.** Never as absent, never as no. A hint whose
 * `tools` claim is missing means nobody established it; showing that row empty
 * would read as "fine", and showing it as "no tools" would libel a model nobody
 * asked. It gets its own word.
 *
 * **A claim carries how it was established.** §3.3 keeps *probed*,
 * *self-described* and *configured* apart, and this is the screen they have to
 * survive to. A server listing `tools` for a model is not the same fact as a
 * model that has been watched calling one — `qwen3:0.6b` claims the first and
 * fails the second — so the declared form says so rather than borrowing the
 * probed form's confidence.
 *
 * **No model-name branching, anywhere.** Every word below comes from a
 * `ModelCapabilityHint` the host established. A table of "models we know are
 * good" is the thing this whole layer exists to not be.
 */

import type { CapabilityConfidence, ModelCapabilityHint } from '../shared/types/index.js';

export interface CapabilityBadge {
  /** Stable across renders and unique within a row. */
  key: string;
  text: string;
  /**
   * `warn` is not a colour decision — it marks the claims that change what the
   * agent can be asked to do. `unknown` is its own tone because an unchecked
   * capability must not look like a checked one in either direction.
   */
  tone: 'plain' | 'warn' | 'unknown';
  /** The long form, including how the claim was established. */
  title: string;
}

/** How a claim was established, in words a person can act on. */
function provenance(from: CapabilityConfidence): string {
  switch (from) {
    case 'probed':
      return 'checked by running the model once';
    case 'self-described':
      return 'reported by the server, not checked';
    case 'configured':
      return 'a fixed property of this adapter, not measured';
  }
}

/** `131072` → `128k`. Windows are quoted in thousands everywhere else. */
export function formatWindow(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}

/**
 * The tool-calling badge, which is the one that caused the incident.
 *
 * Four states, deliberately, because collapsing any two of them is how somebody
 * ends up asking a chat-only model to search:
 *
 * | hint | badge | why it is separate |
 * |---|---|---|
 * | probed, calls tools | `tools` | watched doing it |
 * | probed, cannot | `no tools` | watched failing to |
 * | server says it can | `tools: declared` | the server said so and the server can be wrong |
 * | nothing known | `tools: unknown` | nobody asked, and that is not a "no" |
 */
export function toolBadge(hint: ModelCapabilityHint | undefined): CapabilityBadge {
  const claim = hint?.tools;
  if (claim === undefined) {
    return {
      key: 'tools',
      text: 'tools: unknown',
      tone: 'unknown',
      title:
        'Nobody has established whether this model can call tools. Select it to check — under the Agbrte harness, a model that cannot call tools can only chat.',
    };
  }
  if (claim.value === 'none') {
    return {
      key: 'tools',
      text: 'no tools',
      tone: 'warn',
      title: `This model cannot call tools (${provenance(claim.from)}), so it can only chat: it cannot read, write, search or run anything.`,
    };
  }
  if (claim.from !== 'probed') {
    return {
      key: 'tools',
      text: 'tools: declared',
      tone: 'unknown',
      title: `The server lists tool support for this model (${provenance(claim.from)}). Small models often list it and then fail to produce a well-formed call — select it to check.`,
    };
  }
  return {
    key: 'tools',
    text: claim.value === 'text-protocol' ? 'tools: text' : 'tools',
    tone: 'plain',
    title:
      claim.value === 'text-protocol'
        ? 'No native tool calling; tools are offered as a text protocol and parsed back out (§3.5).'
        : `Calls tools natively (${provenance(claim.from)}).`,
  };
}

export function contextBadge(hint: ModelCapabilityHint | undefined): CapabilityBadge {
  const claim = hint?.contextWindow;
  if (claim === undefined) {
    return {
      key: 'context',
      text: 'context: unknown',
      tone: 'unknown',
      title: 'This endpoint did not report a context window for this model.',
    };
  }
  return {
    key: 'context',
    text: `${formatWindow(claim.value)} ctx`,
    // An assumed floor is not a fact about the model, and a run sized against
    // it will compact earlier than it needs to — worth seeing, not worth
    // alarm.
    tone: claim.from === 'configured' ? 'unknown' : 'plain',
    title:
      claim.from === 'configured'
        ? `The server did not report a window, so ${claim.value.toLocaleString()} tokens is assumed — deliberately low, because overstating it surfaces as an overflow deep into a run.`
        : `${claim.value.toLocaleString()} tokens (${provenance(claim.from)}).`,
  };
}

export function imageBadge(hint: ModelCapabilityHint | undefined): CapabilityBadge {
  const claim = hint?.imageInput;
  if (claim === undefined) {
    return {
      key: 'image',
      text: 'images: unknown',
      tone: 'unknown',
      title: 'Nobody has established whether an image can be sent to this model.',
    };
  }
  return claim.value
    ? {
        key: 'image',
        text: 'images',
        tone: 'plain',
        title: `Images are sent to this model (${provenance(claim.from)}).`,
      }
    : {
        key: 'image',
        text: 'no images',
        tone: 'warn',
        title: `A screenshot sent to this agent arrives as a line of text saying an image was here (${provenance(claim.from)}). Every such downgrade is logged.`,
      };
}

export function reasoningBadge(hint: ModelCapabilityHint | undefined): CapabilityBadge {
  const claim = hint?.reasoningControl;
  if (claim === undefined) {
    return {
      key: 'reasoning',
      text: 'thinking: unknown',
      tone: 'unknown',
      title: 'Nobody has established whether this model takes an effort setting.',
    };
  }
  return claim.value === 'none'
    ? {
        key: 'reasoning',
        text: 'no thinking',
        tone: 'plain',
        title: `This model takes no effort setting (${provenance(claim.from)}), so the session's reasoning control does nothing here.`,
      }
    : {
        key: 'reasoning',
        text: claim.value === 'budget' ? 'thinking: budget' : 'thinking: effort',
        tone: 'plain',
        title: `Reasoning can be asked for (${provenance(claim.from)}).`,
      };
}

/**
 * What fits on one row of a dropdown: the two claims that decide the job.
 *
 * Two rather than four, and the missing two are not an oversight. Every
 * `openai-compatible` model answers `no images` — the adapter flattens an image
 * to a line of text whatever the weights could do — and §3.10 already made the
 * argument about a badge that is always present and always the same: it teaches
 * people to stop reading badges. Both appear in the panel below the list, where
 * they are about the model somebody actually selected.
 */
export function rowBadges(hint: ModelCapabilityHint | undefined): CapabilityBadge[] {
  return [toolBadge(hint), contextBadge(hint)];
}

/** Everything, for the one entry a person has landed on. */
export function panelBadges(hint: ModelCapabilityHint | undefined): CapabilityBadge[] {
  return [toolBadge(hint), contextBadge(hint), imageBadge(hint), reasoningBadge(hint)];
}

/**
 * The sentence a no-tools model needs, or `null`.
 *
 * Separate from the badge because a badge is a label and this is the
 * consequence — the thing the incident's user was never told. It is only ever
 * shown for the entry in front of somebody, so it can afford to be a sentence.
 */
export function toolWarning(hint: ModelCapabilityHint | undefined): string | null {
  const claim = hint?.tools;
  if (claim === undefined || claim.value !== 'none') return null;
  return claim.from === 'probed'
    ? 'This model did not produce a usable tool call when asked, so an agent on it can only chat — it cannot read, write, search or run commands.'
    : 'This endpoint reports no tool support for this model, so an agent on it can only chat — it cannot read, write, search or run commands.';
}

/** Whether anything is worth checking for this model — i.e. it is unprobed. */
export function worthChecking(hint: ModelCapabilityHint | undefined): boolean {
  return hint?.tools?.from !== 'probed';
}

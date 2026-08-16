/**
 * Capability badges, drawn the same way wherever they appear (§3.3, §3.5).
 *
 * One component rather than two renderings, because the row in the dropdown and
 * the panel under it are the *same claim* about the same model seen twice. Two
 * copies would eventually disagree about which state is loud, and the state most
 * likely to drift is `unknown` — the one this whole feature exists to keep
 * distinct from both yes and no.
 *
 * The words come from `modelCapabilities.ts`, which is pure and tested. This
 * file only decides how they sit on a line.
 */

import type { JSX } from 'react';
import type { CapabilityBadge } from './modelCapabilities.js';

export function CapabilityBadges({ badges }: { badges: CapabilityBadge[] }): JSX.Element {
  return (
    <>
      {badges.map((badge) => {
        /*
         * The tone tested out here rather than inside `className`.
         *
         * `scripts/inert-classes.mjs` reads every string literal inside a
         * `className` expression and checks it against the built stylesheet, so
         * a `badge.tone === 'warn'` comparison in there reports `warn` as an
         * undefined class — a false finding, which is how a checker stops being
         * read. The class names themselves stay literal in the attribute, which
         * is what keeps them checked and keeps Tailwind emitting them.
         */
        const warn = badge.tone === 'warn';
        const unknown = badge.tone === 'unknown';
        return (
        <span
          key={badge.key}
          data-testid="capability-badge"
          data-capability={badge.key}
          data-tone={badge.tone}
          /* The long form, including how the claim was established. A badge is
             three words; the difference between "the server says so" and "we
             watched it" needs a sentence, and this is where it fits. */
          title={badge.title}
          /*
           * Spelled out rather than composed from the tone.
           *
           * `cap-${badge.tone}` is invisible to Tailwind's scanner *and* to
           * `scripts/inert-classes.mjs`, which is exactly how a class name goes
           * silently inert — the failure that script exists for.
           */
          className={
            warn ? 'cap-badge cap-warn' : unknown ? 'cap-badge cap-unknown' : 'cap-badge cap-plain'
          }
        >
          {badge.text}
        </span>
        );
      })}
    </>
  );
}

/**
 * The About page (DESIGN.md §7).
 *
 * Version, license, and where the project lives — asked of the process serving
 * the API rather than baked into the bundle, because the answer differs by
 * client: the desktop app describes itself, and a browser tab honestly
 * describes the server it is looking at. `AboutInfo` travels the same IPC as
 * everything else, so the two cannot drift into showing different truths for
 * one installation.
 *
 * The license line names the SPDX id and points at the shipped LICENSE rather
 * than inlining the text: nobody reads 11,000 words in a side panel, and the
 * file is the legally meaningful copy anyway.
 */

import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { AboutInfo } from '@shared/ipc/contract.js';
import { LABEL } from './App.js';
import { applyTheme, rememberTheme, storedTheme } from './applyTheme.js';
import { THEMES } from './themes.js';

export function About(): JSX.Element {
  const [info, setInfo] = useState<AboutInfo | null>(null);

  useEffect(() => {
    // One ask, no subscription: nothing about a build changes while it runs.
    void window.agbrte.app.about().then(setInfo, () => undefined);
  }, []);

  if (info === null) {
    // The IPC round trip is milliseconds; a spinner would flash. Blank is fine.
    return <div data-testid="about" className="m-auto" />;
  }

  return (
    <div className="m-auto grid w-full max-w-xl gap-6 p-6" data-testid="about">
      <div className="grid gap-2">
        <h2 className="text-xl">{info.name}</h2>
        <p className="text-muted text-sm leading-relaxed">{info.description}</p>
      </div>

      <Appearance />

      <div className="grid gap-3">
        <div className="grid gap-1">
          <span className={`${LABEL} text-muted`}>Version</span>
          <span className="text-[13px]" data-testid="about-version">
            {info.version}
          </span>
        </div>

        <div className="grid gap-1">
          <span className={`${LABEL} text-muted`}>License</span>
          <span className="text-[13px]" data-testid="about-license">
            {info.license}
          </span>
          <span className="text-muted text-xs leading-relaxed">
            Free and open source. The full text ships with the app as <code>LICENSE</code>.
          </span>
        </div>

        <div className="grid gap-1">
          <span className={`${LABEL} text-muted`}>Project</span>
          {/* target="_blank" on purpose: in the desktop app the window-open
              handler routes http(s) to the system browser and denies the
              window, and in the web client it is an ordinary new tab. A plain
              href would be cancelled by the navigation guard and look dead. */}
          <a
            className="text-accent text-[13px]"
            href={info.homepage}
            target="_blank"
            rel="noreferrer"
          >
            {info.homepage.replace(/^https?:\/\//, '')}
          </a>
        </div>

        {info.runtime !== undefined && (
          <div className="grid gap-1">
            <span className={`${LABEL} text-muted`}>Running on</span>
            <span className="text-muted text-xs">
              {[
                info.runtime.electron !== undefined ? `Electron ${info.runtime.electron}` : null,
                info.runtime.node !== undefined ? `Node ${info.runtime.node}` : null,
                info.runtime.platform,
              ]
                .filter((part): part is string => part != null)
                .join(' · ')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Choosing a palette (DESIGN.md §4.1, §14).
 *
 * Here rather than behind a settings dialog, because this pane is already where
 * somebody looks to find out what this copy of the program *is* — and because a
 * preference with four options does not earn a window of its own.
 *
 * Applied on press, not on save. There is no state worth confirming: the change
 * is entirely visible, and a palette you cannot see until you press OK is one
 * you have to choose twice.
 *
 * Each row shows the theme rather than describing it. Three swatches — the
 * ground, a panel on it, and the accent — are the three decisions a palette
 * actually makes here, and a name like "Slate" tells somebody nothing about
 * whether the thing that needs them will stand out on it.
 */
function Appearance(): JSX.Element {
  // Read once. Nothing else in the app changes this, so subscribing would be a
  // listener for an event that has exactly one sender sitting next to it.
  const [chosen, setChosen] = useState(() => storedTheme().id);

  return (
    <div className="grid gap-2" data-testid="appearance">
      <span className={`${LABEL} text-muted`}>Appearance</span>
      <div className="grid gap-1.5">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            data-testid="theme-option"
            data-theme-id={theme.id}
            aria-pressed={chosen === theme.id}
            className={`border-line hover:border-muted flex items-center gap-3 rounded-control border px-3 py-2 text-left ${
              chosen === theme.id ? 'border-accent' : ''
            }`}
            onClick={() => {
              applyTheme(theme);
              rememberTheme(theme.id);
              setChosen(theme.id);
            }}
          >
            {/* The palette itself, in the three colours that actually tell these
                apart: the ground, the text on it, and the accent.
                
                Not ground-and-panel, which is what this showed first. Those sit
                one step apart by design, so at swatch size every theme rendered
                as one grey block and a dot — four rows that looked the same. The
                *text* is where warm and graphite genuinely differ, cream against
                white, and it is the thing somebody will be reading.
                
                Inline styles because these are the *other* theme's values, and
                utilities read the one that is on. */}
            <span className="border-line flex shrink-0 gap-0.5 rounded-mark border p-0.5">
              {[theme.palette.bg, theme.palette.ink, theme.palette.accent].map((colour) => (
                <span
                  key={colour}
                  aria-hidden
                  className="block size-4 rounded-mark"
                  style={{ background: colour }}
                />
              ))}
            </span>
            <span className="grid gap-0.5">
              <span className="text-[13px]">{theme.label}</span>
              <span className="text-muted text-xs">{theme.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

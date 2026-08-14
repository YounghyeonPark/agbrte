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

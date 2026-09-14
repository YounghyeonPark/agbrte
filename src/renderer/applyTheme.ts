/**
 * Putting a palette on the window, and remembering which one (DESIGN.md §14).
 *
 * `localStorage`, for `agentDefaults.ts`'s reason: this is a preference of the
 * *client*, not a fact about the work. A host owns the log, the queue and the
 * gate; it does not own what colour somebody likes looking at, and a session
 * driven from a laptop and a phone at once should not force one of them into the
 * other's choice.
 *
 * ## Applied by setting variables, not by swapping a stylesheet
 *
 * Tailwind's `@theme` block emits the tokens on `:root`, and every utility reads
 * them as `var(--color-bg)`. Setting the same names on the root element
 * overrides that — which is what a custom property is for, and it means four
 * palettes cost four small objects rather than four copies of the stylesheet.
 *
 * ## There is still a flash, and it is not this module's to fix
 *
 * `main.ts` gives the window a `backgroundColor` because Electron needs one
 * before any CSS exists to read, and its comment already records the cold flash
 * that produces at launch. With more than one theme that flash is now the
 * *default* theme's ground on a window about to become something else. Applying
 * this before React renders makes it as short as the renderer can make it; the
 * rest would need main to know a preference that lives in the renderer, which is
 * a bigger change than the flicker is worth.
 */

import { cssVariables, DEFAULT_THEME, themeById, type Theme } from './themes.js';

const KEY = 'agbrte.theme';

/**
 * The stored choice, or the default.
 *
 * Shape-checked by `themeById`, which falls back rather than throwing:
 * `localStorage` survives app versions, so a theme that has since been removed
 * has to land on the default instead of on a blank window.
 */
export function storedTheme(): Theme {
  try {
    return themeById(window.localStorage.getItem(KEY));
  } catch {
    // A browser with site data blocked still gets an app, in the default.
    return themeById(DEFAULT_THEME);
  }
}

export function rememberTheme(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // Not being able to remember is not a reason to refuse to apply.
  }
}

/**
 * Paint one palette onto the document.
 *
 * `data-theme` goes on as well as the variables, and it is not decoration: it is
 * how a test says which theme is showing without reading thirteen computed
 * properties, and how a future rule that needs more than a colour swap — a
 * shadow, a border weight — would find its hook.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(cssVariables(theme.palette))) {
    root.style.setProperty(name, value);
  }
  root.setAttribute('data-theme', theme.id);
}

/** Read the stored choice and put it on, before anything renders. */
export function startTheme(): Theme {
  const theme = storedTheme();
  applyTheme(theme);
  return theme;
}

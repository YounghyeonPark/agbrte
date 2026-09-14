import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { startTheme } from './applyTheme.js';
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root missing from index.html');

/*
 * Before anything renders, and deliberately not inside a component.
 *
 * A theme applied in an effect is a theme applied *after* the first paint, which
 * is a window that shows the default palette for a frame and then becomes
 * something else — the same flicker `main.ts` already apologises for, doubled.
 * This is the earliest point in the renderer that has a DOM to write to.
 *
 * An inline script in `index.html` would be earlier still and cannot be used:
 * the CSP there is `script-src 'self'` with no `unsafe-inline`, which is holding
 * back model output that reaches the DOM and is not worth relaxing for a frame.
 */
startTheme();

createRoot(host).render(<App />);

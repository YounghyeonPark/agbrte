/**
 * An agent's reply, drawn for a terminal.
 *
 * Models answer in Markdown. Printed raw, a reply is asterisks, backticks and
 * pound signs around the text a person wanted; rendered to HTML it would need a
 * browser. This renders it the way a terminal can — bold, colour, indentation,
 * and links a terminal can click — and nothing a terminal cannot, so a table is
 * left as the text it was written as rather than redrawn badly.
 *
 * Hand-written rather than a dependency, at the owner's request (self-made where
 * it can be): the subset models use in practice is small, and a full CommonMark
 * parser would be thousands of lines to render the same twelve things.
 *
 * Whole messages only: `agent.text` arrives complete, so there is no half-open
 * code fence to guess about.
 */

export interface Style {
  bold(s: string): string;
  italic(s: string): string;
  dim(s: string): string;
  /** Headings and the bullet: the palette's highlight. */
  accent(s: string): string;
  /** Inline code and code blocks. */
  code(s: string): string;
  /** A clickable link, where the terminal supports OSC 8. */
  link(text: string, url: string): string;
}

const sgr = (on: string, off: string) => (s: string): string => `\u001b[${on}m${s}\u001b[${off}m`;

/** ANSI styling. `plain` for a pipe or `NO_COLOR`, where every function is the identity. */
export const ansiStyle: Style = {
  bold: sgr('1', '22'),
  italic: sgr('3', '23'),
  dim: sgr('2', '22'),
  accent: sgr('33', '39'),
  code: sgr('36', '39'),
  link: (text, url) => `\u001b]8;;${url}\u0007${sgr('4', '24')(text)}\u001b]8;;\u0007`,
};

export const plainStyle: Style = {
  bold: (s) => s,
  italic: (s) => s,
  dim: (s) => s,
  accent: (s) => s,
  code: (s) => s,
  link: (text, url) => (text === url ? url : `${text} (${url})`),
};

/** Inline spans: code first, so nothing inside backticks is read as emphasis. */
export function renderInline(text: string, style: Style): string {
  const parts = text.split(/(`+[^`]*`+)/u);
  return parts
    .map((part) => {
      const code = /^(`+)([^`]*)\1$/u.exec(part);
      if (code !== null) return style.code(code[2] ?? '');
      return part
        .replace(/\[([^\]]+)\]\((\S+?)\)/gu, (_m, label: string, url: string) => style.link(label, url))
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/gu, (_m, a?: string, b?: string) => style.bold(a ?? b ?? ''))
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/gu, (_m, pre: string, t: string) => `${pre}${style.italic(t)}`)
        .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/gu, (_m, pre: string, t: string) => `${pre}${style.italic(t)}`);
    })
    .join('');
}

/** A whole reply, as the lines to print. */
export function renderMarkdown(text: string, style: Style, columns = 80): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  let fence: { marker: string; lang: string } | null = null;

  for (const line of lines) {
    if (fence !== null) {
      if (line.trimStart().startsWith(fence.marker)) {
        fence = null;
        continue;
      }
      out.push(`  ${style.code(line)}`);
      continue;
    }

    const open = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/u.exec(line);
    if (open !== null) {
      fence = { marker: open[1] ?? '```', lang: open[2] ?? '' };
      if (fence.lang !== '') out.push(`  ${style.dim(fence.lang)}`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      out.push(style.bold(style.accent(renderInline(heading[2] ?? '', style))));
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      out.push(style.dim('─'.repeat(Math.max(3, Math.min(columns, 60)))));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/u.exec(line);
    if (quote !== null) {
      out.push(`${style.dim('│')} ${style.dim(renderInline(quote[1] ?? '', style))}`);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(line);
    if (bullet !== null) {
      out.push(`${bullet[1] ?? ''}${style.accent('•')} ${renderInline(bullet[2] ?? '', style)}`);
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/u.exec(line);
    if (numbered !== null) {
      out.push(`${numbered[1] ?? ''}${style.accent(`${numbered[2] ?? ''}.`)} ${renderInline(numbered[3] ?? '', style)}`);
      continue;
    }

    out.push(renderInline(line, style));
  }
  // An unclosed fence is still code; it was printed as such line by line.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

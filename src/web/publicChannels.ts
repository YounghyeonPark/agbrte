/**
 * What a host answers when the person on the socket is a stranger (§13, §7).
 *
 * ## Why this exists beside the tool list and not instead of it
 *
 * `PUBLIC_TOOLS` withdraws what an *agent* may do. This withdraws what a *client*
 * may do, and they are different attack surfaces reached by different routes: an
 * agent asks the harness for `bash`, a browser asks the web server for
 * `shell.open`. Restricting one and not the other leaves the whole hole open —
 * a visitor who cannot get a shell through the model can simply open a terminal
 * panel in the UI, which is a real pty on the server and never went near a
 * runtime.
 *
 * The tool list lives on the host because the agent loop does. This lives on the
 * web server because that is the only door a stranger arrives at: the session
 * host's own socket is local and `0600`, so the browser bridge is the boundary,
 * and a boundary check belongs at the boundary.
 *
 * ## An allowlist, and the reason is the same one as `PUBLIC_TOOLS`
 *
 * A denylist of the dangerous channels would be shorter and would quietly
 * publish the next one somebody adds. Eighty-three methods is exactly the size
 * where "I will remember to add it to the list" is false. So the default for
 * anything not named here is refusal, and a new capability reaching a public
 * host is a line somebody writes on purpose.
 *
 * ## What is deliberately still allowed
 *
 * A visitor can create sessions, send turns, answer permission prompts, read
 * files and search the log. That is not an oversight — it is the product. The
 * safety does not come from making the demo read-only; it comes from the agent
 * holding only tools that cannot leave the workspace directory, and from the
 * workspace being a throwaway. A read-only demo would be the recording again,
 * with more machinery.
 */

import { CH } from '../shared/ipc/contract.js';

/**
 * The channels a public host answers.
 *
 * Grouped by the reason each group is here, because the next person to add one
 * needs to know which argument they are extending.
 */
export const PUBLIC_CHANNELS: ReadonlySet<string> = new Set([
  // Reading what exists. None of these can change anything.
  CH.appAbout,
  CH.hostsList,
  CH.hostsRuntimes,
  CH.hostsConformance,
  CH.hostsModels,
  CH.hostsModelCapabilities,
  CH.inboxList,
  CH.inboxMarkRead,
  CH.filesList,
  CH.filesRead,
  CH.sessionsList,
  CH.sessionsListOnDisk,
  CH.sessionsSnapshot,
  CH.sessionsSince,
  CH.sessionsSearch,
  CH.sessionsRawLog,
  CH.sessionsExport,
  CH.sessionsBlob,

  // Driving a session, which is the entire point of letting somebody in.
  CH.sessionsCreate,
  CH.sessionsAddAgent,
  CH.sessionsSend,
  CH.sessionsInterrupt,
  CH.sessionsResume,
  CH.sessionsRename,
  CH.sessionsSetReasoning,
  CH.sessionsGroup,
  CH.sessionsUngroup,
  CH.sessionsRespondSplit,

  /*
   * Answering a permission prompt, which has to be allowed for the demo to show
   * the thing it is most worth showing — the gate (§13). It is not a widening:
   * the prompt only ever offers what the agent asked for, and the agent can only
   * ask for a `PUBLIC_TOOLS` tool on a path inside the workspace. Saying yes to
   * a confined tool is still confined.
   */
  CH.permissionsPending,
  CH.permissionsRespond,
]);

/**
 * Why a channel is refused, in a sentence a visitor can act on.
 *
 * Named reasons rather than one blanket line, because the three groups mean
 * genuinely different things and "not available" would send somebody to the
 * issue tracker for a decision. Someone who wanted a terminal should be told to
 * run their own host, not told the button is broken.
 */
export function refusalFor(channel: string): string {
  if (channel.startsWith('agbrte:shell.')) {
    return (
      'a terminal is not offered on the public demo — it is a real shell on the ' +
      'machine serving this page. Run your own host and you get one.'
    );
  }
  if (channel.startsWith('agbrte:capture.') || channel.startsWith('agbrte:preview.')) {
    return (
      'this needs a screen or a server process on the machine serving the page, ' +
      'which the public demo does not hand out. Run your own host and it works.'
    );
  }
  if (channel.startsWith('agbrte:hosts.') || channel === CH.sessionsAttachMcp) {
    return (
      'attaching machines, folders and MCP servers is turned off on the public ' +
      'demo. Run your own host to attach your own work.'
    );
  }
  return 'that is turned off on the public demo. Run your own host and it works.';
}

/** Whether this channel may be served to a stranger. */
export function admitsChannel(channel: string): boolean {
  return PUBLIC_CHANNELS.has(channel);
}

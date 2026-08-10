/**
 * What this machine offers Agbrte, printed rather than assumed.
 *
 * A green CI tick says the tests passed; it does not say which platform-specific
 * paths were *exercised*. Several of Agbrte's OS-facing capabilities are
 * detection-based by design — §3.12 for a CLI, §12.1 for a browser, §12.4 for
 * speech — and "detected nothing" is a legitimate result that looks identical to
 * "was never asked".
 *
 * So this prints the answers. On a CI runner it is a record of what that OS
 * actually offered; on a developer's machine it answers "why is the microphone
 * button missing" without reading any code.
 *
 * **It never fails the build**, and it deliberately checks no behaviour. Nothing
 * here is a requirement — a machine with no speech synthesis is a fact about the
 * machine, which is the position every one of these detectors already takes. The
 * one thing that *is* required per platform, enumerating listening ports, is a
 * test (`previewPorts.test.ts`) which opens a real socket and fails if this OS
 * cannot see it. A check that matters belongs where a failure is a failure.
 */

import { existsSync } from 'node:fs';
import { platform, release, arch } from 'node:os';

const os = platform();
const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);

console.log(`\nAgbrte platform report — ${os} ${release()} ${arch()}, node ${process.version}\n`);

line('speech synthesis', speech());
line('speech recognition', whisper());
line('headless browser', browser());
line('host control channel', os === 'win32' ? 'named pipe' : 'unix socket');
line('port enumeration', enumerator());
line('preview process kill', os === 'win32' ? 'taskkill /T' : 'process group');
console.log('');

/** §12.4: OS-native, detected, never bundled. */
function speech() {
  if (os === 'darwin') return existsSync('/usr/bin/say') ? '/usr/bin/say' : 'say(1) missing';
  if (os === 'win32') return 'SAPI via PowerShell';
  const found = ['/usr/bin/spd-say', '/usr/bin/espeak-ng', '/usr/bin/espeak'].find(existsSync);
  return found ?? 'none installed — dictation reads back silently';
}

/** §12.4 again: whisper.cpp if the user has it, and nothing downloaded if not. */
function whisper() {
  const found = [
    '/usr/local/bin/whisper-cli',
    '/usr/bin/whisper-cli',
    '/opt/homebrew/bin/whisper-cli',
  ].find(existsSync);
  return found ?? 'none detected — dictation off';
}

/** §12.1: a browser the machine already has, driven headless. */
function browser() {
  const found = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(existsSync);
  return found ?? 'none detected — §12.1 headless capture off';
}

/** §6.8: how this OS is asked what is listening. */
function enumerator() {
  if (os === 'linux') return '/proc/net/tcp (uid column)';
  if (os === 'darwin') return 'lsof -F (lsof -u filters)';
  if (os === 'win32') return 'netstat -ano (kill(pid,0) filters)';
  return 'none — listing refuses rather than answering empty';
}

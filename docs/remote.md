# Attaching a machine over ssh

[← README](../README.md)

The one flow worth spelling out, because the name field does more than it looks
like.

`Attach host… → Remote`, then a name and a path. The name is an alias from your
`~/.ssh/config`, or `user@hostname`, which needs no config at all — Agbrte shells
out to `ssh`, so your keys, ports, jump hosts and `ProxyCommand`s already apply,
and any NAT-traversal tool that makes `ssh <name>` work makes this work too.

The first attach installs a private Node under `~/.agbrte` and copies the session
and agent host bundles there; nothing system-wide, no sudo, and later attaches
reuse them. If you would rather install it yourself, or the machine is one you
reach some other way, [the one-file installer](install.md#on-a-server) puts the
same thing in the same place.

A machine ssh has never reached fails in one of a few specific ways — an
unconfirmed host key, refused credentials, a name that does not resolve — and
Agbrte names which one and the command that settles it. **It will not accept a
host key for you:** that check only means something if a human compares the
fingerprint against something other than the connection presenting it.

## Once it is attached

The host on that machine outlives the app. Quitting on your laptop does not stop
a turn running on the server, and the next attach finds the same process rather
than starting a rival — a host is proved to be there by connecting to it, never
by reading a record it left behind.

## Seeing what is on that machine

**Ports** in the session pane forwards a port from the remote machine to a local
one. It is `ssh -L` and nothing more, so it carries whatever is listening:

- A **dev server** the agent started — the case the feature was built for. The
  row gives you a link; open it and you are looking at the page the agent is
  working on.
- That machine's **screen**. Forward `3389` on Windows, or `5900` where a VNC
  server is running, and point your own remote-desktop client at the address the
  row shows. Live, with input and the clipboard, because that is what those
  clients are for — Agbrte does not re-implement one.

A port the app recognises says what it is, and one a browser cannot speak gets
the address as text rather than a link that would fail on press. Forwards belong
to the session and are torn down with it, so a tunnel cannot outlive the thing
that explained it.

The screenshot tool is a different question and a different answer: it captures a
**page** the agent is serving, as a still, so the *model* can see what it built.
Watching the machine yourself is the tunnel above.

What crosses the link, and what deliberately does not, is
[§6 of DESIGN.md](../DESIGN.md) and the
[design page](https://agbrte.dev/idea/).

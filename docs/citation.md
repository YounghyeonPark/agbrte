# Citing it, patents, and the licence

[← README](../README.md)

## Using it in research, or in a patent

If this project — the code, or the design decisions written up in
[DESIGN.md](../DESIGN.md) — feeds into a paper, a thesis, a technical report or a
patent application, a citation is appreciated. [CITATION.cff](../CITATION.cff) has
the metadata, and GitHub turns it into a **Cite this repository** button at the
top of the repository page.

Archived releases carry a DOI:
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21906998.svg)](https://doi.org/10.5281/zenodo.21906998)

That is the **concept** DOI, which resolves to the newest archived version. Cite
it unless you specifically need to pin a reader to the exact release you used,
in which case take the version DOI from the Zenodo page it sends you to.

**This is a request, not a licence term.** Apache-2.0 requires that you keep the
copyright notice and [NOTICE](../NOTICE) when you redistribute; it does not require
that you cite anything, and nothing in this section adds a condition to the
licence. You are free to use this without asking and without crediting a paper.
The asking is separate from the permission, and deliberately so — a licence that
quietly grew an academic obligation would be a worse licence.

## Patents

Two things are worth knowing rather than discovering later. This repository is
public and its commits are dated, which makes it **prior art**: that is useful to
you if you are establishing what was already known, and it limits what anyone —
including me — can later claim as novel over it. And Apache-2.0 §3 already grants
you a patent licence for what the contributors put into this work, with the usual
retaliation clause: sue over the work infringing your patent and that grant ends.

If you are filing something that builds on this, I would genuinely like to hear
about it beforehand — not to object, but because the interesting conversation is
usually upstream of the filing.

## Collaboration

If you are building on this seriously — a research group, a product, a thesis —
an email is welcome: **ypark.dev@gmail.com**. Issues and pull requests are fine
too. There is no obligation attached to any of this; the code works the same
either way.

## The licence, in more detail

Apache License 2.0 — see [LICENSE](../LICENSE) and [NOTICE](../NOTICE). Chosen over
MIT for two things it adds: an explicit patent grant, and a trademark clause, so
the code can be forked freely while the name stays with the project.

**The one proprietary dependency is gone.** `@anthropic-ai/claude-agent-sdk`,
published under Anthropic's own terms, was a build dependency of an in-process
adapter; both were removed (DESIGN.md §3.14). It reached no shipped bundle — but
only because the adapter importing it happened not to be registered in a headless
entry point, and an accident that holds is not a guarantee. So the licence gate in
`npm run package`, which refuses to build the installer if any Anthropic code
appears in the bundles, stays now that the dependency is gone: the next
proprietary SDK will arrive as a convenience inside one adapter, and that script
is where redistribution would actually happen.

Every runtime dependency — React, `react-dom`, zustand, one Radix component,
xterm, `node-pty`, `electron-updater` — is MIT. The wider build tree is permissive
but not uniformly one licence; [NOTICE](../NOTICE) carries the attribution.

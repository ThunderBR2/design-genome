---
name: design-genome
description: Design inside a reverse-engineered visual system. Use when the user wants work that follows a brand or design language learned from real sources (sites, brand books, images, videos, Figma), wants to learn a new design system from sources, or wants a design checked for conformance. Requires the design-genome MCP server.
---

# Design Genome

A design genome is a cross-checked model of a visual system. Every token and
rule in it came from a source (a measured site, a Figma file, a brand
document, product photography or film) and carries its evidence.

## Read the genome before designing

1. Call `genome_brief`. It is compact and ranked: rules by confidence, the
   palette, the type ramp, space/shape/motion, imagery direction, voice, open
   conflicts and unknowns.
2. Pull a facet with `genome_query` only when you need detail, for example
   `{"facet": "typography", "role": "display"}` or `{"facet": "rules", "topic": "imagery"}`.

## How much to trust each fact

| Status | Meaning | How to use it |
|---|---|---|
| confirmed | two or more independent sources agree | follow it |
| single-source | one source shows it | follow it, but mention it when it drives a key decision |
| declared-only | the brand says it; nothing measured shows it | treat as intent; ask if it matters |
| conflicted | sources disagree | do not pick a side; ask the user, or follow the recorded decision |

Precision explains the source of a value: exact (rendered CSS, Figma),
declared (documents), estimated (pixels), inferred (vision model).

- Never invent a value the genome lists as unknown. Say it is unknown.
- Type ramps are often not modular. When the brief says "explicit list",
  use the listed sizes; when tracking is a table, interpolate between rows.
- Restricted typefaces are listed with substitutes. Deliverables use the
  substitute unless the user confirms they hold the license.
- Logos, wordmarks, icons, photography and copy of the source brand are
  reference only. Match the system, not the assets.

## Close the loop

After producing a page, render it (URL or local HTML file) and call
`genome_verify`. Fix every high and medium deviation, then verify again. For
generated images, verify the image file: palette and imagery statistics are
compared with the genome.

## Learning a new system

Use `genome_add_sources` with the user's links and files. Start with an exact
source (live site or Figma), then add images and video of the same brand, and
the brand book if there is one. Link screenshots to the page they show with
`depicts` so they can be calibrated. Report open conflicts to the user and
record their decisions with `genome_resolve_conflict` only after they choose.

---
name: design-genome
description: Design inside a reverse-engineered visual system. Use when the user wants work that follows a brand or design language learned from real sources (sites, brand books, images, videos, Figma), wants to learn a new design system from sources, or wants a design checked for conformance. Requires the design-genome MCP server.
---

# Design Genome

A design genome is a cross-checked model of a visual system. Every token and
rule in it came from a source (a measured site, a Figma file, a brand
document, product photography or film) and carries its evidence.

## Read the genome before designing

1. Call `genome_brief`. It is compact and ranked: the project concept and
   the composition constants (when pieces were dissected), rules by
   confidence, the palette, the type ramp, space/shape/motion, imagery
   direction, voice, open conflicts and unknowns.
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

## Dissecting pieces (the anatomy)

Every image, video shot and page section is a piece with a measured anatomy:
numbered element boxes, margins, distances between neighbours, shared
alignment edges, column grid, spacing rhythm, type scale, balance, position
against thirds and golden lines, open ground and reading path. Sites are
measured from the rendered boxes (exact); images and frames from pixels
(estimated, and text sizes there are ink heights).

What measurement cannot say is why. You read it:

1. `genome_dissect_request` gives you the piece, the same piece with its
   anatomy drawn on it, and the numbers.
2. Look like an art director and design teacher. For every numbered block
   say its role, what it shows, its treatment and **why it is there, at that
   position, size and distance**, citing the measurements. Then the
   composition and its principles, why the piece works, its intent, what is
   fragile, and reusable rules. Fix wrong merges or splits in `corrections`.
3. `genome_dissect_submit`. Rules that other pieces or sources share become
   confirmed. Repeat until every piece is read.
4. `genome_concept_request` shows all pieces at once with their readings and
   the measured constants (what never changes across pieces) and variations.
   Explain the project as its creative director would: big idea, concept,
   why it is this way, constants, variables, grammar, signature moves, how to
   adapt it, what to avoid. Store it with `genome_concept_submit`.

Write the readings in the user's language. Interpretation is welcome; it is
stored as inferred.

## Creating a new piece

1. `genome_blueprint` with the request and the format (`instagram-post`,
   `story`, `a4-portrait`, `web-desktop`… or width and height). It picks the
   closest references, re-lays the best one out on the new canvas in px
   (margins and type scale with the short side, stacks keep their gaps, the
   main image flexes, story safe areas respected) and brings the concept,
   the measured constants, the reason for each element and the rules.
2. Show the plan to the user before producing when the piece matters.
3. Build with new content. Keep the reasons and the relations (margins,
   shared edges, gap ratios, type contrast), never the reference's copy,
   logo or photos.
4. Verify with `genome_verify`.

## Reading images yourself

The dissection above supersedes this pass when there is time to read piece
by piece. You are the vision model; no API key is involved. After sources are
extracted, call `genome_vision_request` (it picks the next source without a
reading), look at the numbered images as an art director, and call
`genome_vision_submit` with rules and labels that cite image numbers. Repeat
while sources remain. Describe only what is visible. Rules that other sources
also show (the brand book, other films or shoots) become confirmed.

## Learning a new system

Use `genome_add_sources` with the user's links and files. Start with an exact
source (live site or Figma), then add images and video of the same brand, and
the brand book if there is one. Link screenshots to the page they show with
`depicts` so they can be calibrated. Report open conflicts to the user and
record their decisions with `genome_resolve_conflict` only after they choose.

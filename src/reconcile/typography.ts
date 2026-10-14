import { familyKey, fontReuse } from "../core/fonts.js";
import type { FontFamilyToken, Genome, TrackingCurve, TypeStyleToken } from "../core/genome.js";
import type { Observation } from "../core/model.js";
import { fitModularScale, linearFit, median } from "../core/numeric.js";
import type { ReconcileContext } from "./context.js";

type TypeObs = Observation & { value: Extract<Observation["value"], { kind: "typography" }> };

const ROLE_ORDER = ["display", "headline", "title", "body", "callout", "caption", "button", "link"];

export const reconcileTypography = (ctx: ReconcileContext): Genome["typography"] => {
  const all = ctx.of("typography") as TypeObs[];
  const measured = all.filter((o) => o.precision === "exact" || o.precision === "declared");

  // Families: one token per family (vendor optical-size variants merged).
  const byFamily = new Map<string, TypeObs[]>();
  for (const o of all) {
    const key = familyKey(o.value.family);
    if (!key) continue;
    byFamily.set(key, [...(byFamily.get(key) ?? []), o]);
  }
  const observedTotal = all.filter((o) => o.precision !== "declared").reduce((s, o) => s + o.count, 0) || 1;
  const families: FontFamilyToken[] = [...byFamily.values()]
    .map((members) => {
      const name = mostCommon(members.map((m) => m.value.family.replace(/\s+(display|text)$/i, "")))!;
      const reuse = fontReuse(name);
      const share = members.filter((m) => m.precision !== "declared").reduce((s, m) => s + m.count, 0) / observedTotal;
      return {
        family: name,
        roles: sortRoles([...new Set(members.map((m) => m.context.role).filter((r): r is string => Boolean(r)))]),
        share: Math.round(share * 1000) / 1000,
        reuse: reuse.reuse,
        ...(reuse.note ? { reuseNote: reuse.note } : {}),
        ...(reuse.substitute ? { substitute: reuse.substitute } : {}),
        support: ctx.support(members),
      };
    })
    .filter((f) => f.share >= 0.01 || f.support.sources.some((s) => s.precision === "declared"))
    .sort((a, b) => b.share - a.share);

  // Styles: the distinct (role, size, weight, tracking, leading) combinations per viewport.
  const styleGroups = new Map<string, TypeObs[]>();
  for (const o of measured) {
    if (!o.value.sizePx) continue;
    const key = JSON.stringify([o.context.role ?? "text", o.value.sizePx, o.value.weight ?? null, o.value.trackingEm ?? 0, o.value.lineHeight ?? null, o.context.viewport ?? null, o.value.transform ?? null]);
    styleGroups.set(key, [...(styleGroups.get(key) ?? []), o]);
  }
  const perRoleViewport = new Map<string, { members: TypeObs[]; count: number }[]>();
  for (const members of styleGroups.values()) {
    const first = members[0]!;
    const rv = `${first.context.role ?? "text"}|${first.context.viewport ?? ""}`;
    const count = members.reduce((s, m) => s + m.count, 0);
    perRoleViewport.set(rv, [...(perRoleViewport.get(rv) ?? []), { members, count }]);
  }
  const styles: TypeStyleToken[] = [];
  for (const groups of perRoleViewport.values()) {
    for (const { members } of groups.sort((a, b) => b.count - a.count).slice(0, 4)) {
      const v = members[0]!.value;
      const role = members[0]!.context.role ?? "text";
      const viewport = members[0]!.context.viewport;
      styles.push({
        id: `type-${role}-${v.sizePx}${v.weight ? `-${v.weight}` : ""}${viewport ? `@${viewport}` : ""}`,
        role,
        family: v.family,
        sizePx: v.sizePx!,
        ...(v.weight ? { weight: v.weight } : {}),
        ...(v.lineHeight ? { lineHeight: v.lineHeight } : {}),
        ...(v.trackingEm !== undefined ? { trackingEm: v.trackingEm } : {}),
        ...(v.transform ? { transform: v.transform } : {}),
        ...(viewport ? { viewport } : {}),
        support: ctx.support(members),
      });
    }
  }
  styles.sort((a, b) => (b.viewport ?? 0) - (a.viewport ?? 0) || b.sizePx - a.sizePx);
  const ids = new Map<string, number>();
  for (const s of styles) {
    const n = ids.get(s.id) ?? 0;
    ids.set(s.id, n + 1);
    if (n > 0) (s as { id: string }).id = `${s.id}-${n + 1}`;
  }

  // Scale and tracking come from the widest viewport's exact readings.
  const exact = measured.filter((o) => o.precision === "exact" && o.value.sizePx);
  const widest = Math.max(0, ...exact.map((o) => o.context.viewport ?? 0));
  const desktop = exact.filter((o) => (o.context.viewport ?? 0) === widest);
  const sizeWeights = new Map<number, number>();
  for (const o of desktop) sizeWeights.set(o.value.sizePx!, (sizeWeights.get(o.value.sizePx!) ?? 0) + Math.log2(1 + o.count));
  const bodyCandidates = desktop.filter((o) => o.context.role === "body");
  const base = bodyCandidates.length ? mostCommonWeighted(bodyCandidates.map((o) => [o.value.sizePx!, o.count])) : 16;
  const fit = fitModularScale([...sizeWeights.entries()].map(([value, weight]) => ({ value, weight })), base ?? 16);
  const scale = fit
    ? {
        ...fit,
        description: fit.modular
          ? `Sizes follow a modular scale: ${fit.base}px × ${fit.ratio}^n${fit.namedRatio ? ` (${fit.namedRatio})` : ""}.`
          : `No single ratio explains the sizes (best ${fit.ratio}, error ${fit.error} steps): treat the ramp as an explicit list, not a formula.`,
      }
    : null;

  const points = [...groupBy(desktop.filter((o) => o.value.trackingEm !== undefined), (o) => `${o.value.sizePx}|${o.value.trackingEm}`).values()].map((members) => ({
    x: Math.log(members[0]!.value.sizePx!),
    y: members[0]!.value.trackingEm!,
    w: Math.log2(1 + members.reduce((s, m) => s + m.count, 0)),
  }));
  const lf = linearFit(points);
  const table = [...groupBy(desktop.filter((o) => o.value.trackingEm !== undefined), (o) => String(o.value.sizePx)).values()]
    .map((members) => {
      const counts = new Map<number, number>();
      for (const m of members) counts.set(m.value.trackingEm!, (counts.get(m.value.trackingEm!) ?? 0) + m.count);
      return { sizePx: members[0]!.value.sizePx!, trackingEm: [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0] };
    })
    .sort((a, b) => a.sizePx - b.sizePx);
  let tracking: TrackingCurve | null = null;
  if (lf && points.length >= 4 && new Set(points.map((p) => p.y)).size >= 2) {
    const at = (size: number) => Math.round((lf.slope * Math.log(size) + lf.intercept) * 1000) / 1000;
    tracking = {
      fit: lf,
      table,
      formula: `trackingEm = ${lf.slope} × ln(sizePx) + ${lf.intercept}`,
      description:
        lf.r2 >= 0.5 && Math.abs(lf.slope) > 0.002
          ? `Tracking depends on size (r²=${lf.r2}): ${at(12)}em at 12px, ${at(17)}em at 17px, ${at(40)}em at 40px, ${at(80)}em at 80px.${lf.slope < 0 ? " Larger text is set tighter." : ""}`
          : `Tracking is set per size, not by one formula (r²=${lf.r2}): ${table.map((t) => `${t.sizePx}px ${t.trackingEm > 0 ? "+" : ""}${t.trackingEm}em`).join(", ")}. Interpolate between neighbours for new sizes.`,
    };
  }

  const ratioFor = (pred: (o: TypeObs) => boolean): number | null => {
    const values = desktop.filter((o) => pred(o) && o.value.lineHeight).map((o) => o.value.lineHeight!);
    const m = median(values);
    return m === null ? null : Math.round(m * 100) / 100;
  };
  const lineHeight = desktop.length
    ? { display: ratioFor((o) => o.context.role === "display" || o.context.role === "headline"), body: ratioFor((o) => o.context.role === "body") }
    : null;

  return { families, styles: styles.slice(0, 80), scale, tracking, lineHeight };
};

export const sortRoles = (roles: string[]): string[] =>
  roles.sort((a, b) => (ROLE_ORDER.indexOf(a) + 100) % 100 - (ROLE_ORDER.indexOf(b) + 100) % 100);

const mostCommon = <T>(values: readonly T[]): T | undefined => {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

const mostCommonWeighted = (pairs: readonly [number, number][]): number | undefined => {
  const counts = new Map<number, number>();
  for (const [v, w] of pairs) counts.set(v, (counts.get(v) ?? 0) + w);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

export const groupBy = <T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
};

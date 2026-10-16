/**
 * Runs inside the page (serialized by Playwright). Must stay self-contained:
 * no imports, no closures over module scope. Reads only what the browser itself
 * computed, so every value here is exact for the rendered viewport.
 */
export interface PageElement {
  /** Stable index written on the element (data-dg-i) so later passes can find it again. */
  readonly idx: number;
  readonly selector: string;
  readonly tag: string;
  readonly box: { x: number; y: number; w: number; h: number };
  /** Extent of the element's text itself (not its block): what the eye sees as the text block. */
  readonly textBox?: { x: number; y: number; w: number; h: number };
  readonly text: string;
  readonly ownText: boolean;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly textTransform: string;
  readonly color: string;
  readonly background: string;
  readonly backgroundImage: string;
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly radius: number;
  readonly shadow: string;
  readonly padding: [number, number, number, number];
  readonly margin: [number, number, number, number];
  readonly gap: [number, number];
  readonly transition: { property: string; duration: string; easing: string };
  readonly animation: { name: string; duration: string; easing: string };
  readonly maxWidth: string;
  readonly width: number;
  readonly display: string;
  readonly role: string | null;
  readonly isInteractive: boolean;
}

export interface PageCollection {
  readonly url: string;
  readonly title: string;
  readonly docHeight: number;
  readonly viewport: number;
  readonly elements: PageElement[];
  readonly vars: { name: string; value: string; selector: string; href: string | null }[];
  readonly fontFaces: { family: string; weight: string; src: string; href: string | null }[];
  readonly media: { query: string; href: string | null }[];
  readonly animations: { duration: number; easing: string; properties: string[]; target: string }[];
  readonly blockedSheets: string[];
  readonly truncated: boolean;
}

export function collectPage(maxElements: number): PageCollection {
  const px = (v: string): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const cls = [...node.classList].find((c) => /^[A-Za-z][\w-]*$/.test(c));
      if (cls) part += `.${cls}`;
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  const vars: PageCollection["vars"] = [];
  const fontFaces: PageCollection["fontFaces"] = [];
  const media: PageCollection["media"] = [];
  const blockedSheets: string[] = [];
  const walk = (rules: CSSRuleList, href: string | null): void => {
    for (const rule of [...rules]) {
      if (rule instanceof CSSStyleRule) {
        if (/(^|,)\s*(:root|html)\b/.test(rule.selectorText)) {
          for (let i = 0; i < rule.style.length; i++) {
            const name = rule.style[i]!;
            if (name.startsWith("--")) vars.push({ name, value: rule.style.getPropertyValue(name).trim(), selector: rule.selectorText, href });
          }
        }
      } else if (rule instanceof CSSFontFaceRule) {
        fontFaces.push({
          family: rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim(),
          weight: rule.style.getPropertyValue("font-weight").trim(),
          src: rule.style.getPropertyValue("src").slice(0, 300),
          href,
        });
      } else if (rule instanceof CSSMediaRule) {
        media.push({ query: rule.conditionText ?? rule.media.mediaText, href });
        walk(rule.cssRules, href);
      } else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) {
        walk((rule as CSSGroupingRule).cssRules, href);
      }
    }
  };
  for (const sheet of [...document.styleSheets]) {
    try {
      walk(sheet.cssRules, sheet.href);
    } catch {
      blockedSheets.push(sheet.href ?? "(inline)");
    }
  }

  const elements: PageElement[] = [];
  const all = document.querySelectorAll("body *");
  let truncated = false;
  for (const el of all) {
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "BR"].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
    const text = ownText ? (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const tag = el.tagName.toLowerCase();
    let textBox: PageElement["textBox"];
    if (ownText) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tr = range.getBoundingClientRect();
      if (tr.width >= 1 && tr.height >= 1) textBox = { x: Math.round(tr.x), y: Math.round(tr.y + window.scrollY), w: Math.round(tr.width), h: Math.round(tr.height) };
    }
    elements.push({
      idx: Number(el.getAttribute("data-dg-i") ?? -1),
      ...(textBox ? { textBox } : {}),
      selector: selectorOf(el),
      tag,
      box: { x: Math.round(rect.x), y: Math.round(rect.y + window.scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
      text,
      ownText,
      fontFamily: cs.fontFamily,
      fontSize: px(cs.fontSize),
      fontWeight: parseInt(cs.fontWeight, 10) || 400,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
      color: cs.color,
      background: cs.backgroundColor,
      backgroundImage: cs.backgroundImage === "none" ? "" : cs.backgroundImage.slice(0, 200),
      borderColor: cs.borderTopColor,
      borderWidth: px(cs.borderTopWidth),
      radius: px(cs.borderTopLeftRadius),
      shadow: cs.boxShadow === "none" ? "" : cs.boxShadow,
      padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
      margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
      gap: [px(cs.rowGap), px(cs.columnGap)],
      transition: { property: cs.transitionProperty, duration: cs.transitionDuration, easing: cs.transitionTimingFunction },
      animation: { name: cs.animationName, duration: cs.animationDuration, easing: cs.animationTimingFunction },
      maxWidth: cs.maxWidth,
      width: Math.round(rect.width),
      display: cs.display,
      role: el.getAttribute("role"),
      isInteractive: tag === "a" || tag === "button" || el.getAttribute("role") === "button" || tag === "input",
    });
  }

  const animations: PageCollection["animations"] = [];
  for (const anim of document.getAnimations().slice(0, 200)) {
    const effect = anim.effect as KeyframeEffect | null;
    if (!effect) continue;
    const timing = effect.getComputedTiming();
    const props = new Set<string>();
    try {
      for (const frame of effect.getKeyframes()) for (const k of Object.keys(frame)) if (!["offset", "easing", "composite", "computedOffset"].includes(k)) props.add(k);
    } catch {
      /* cross-origin or detached */
    }
    animations.push({
      duration: typeof timing.duration === "number" ? timing.duration : 0,
      easing: effect.getTiming().easing ?? "linear",
      properties: [...props],
      target: effect.target ? selectorOf(effect.target) : "",
    });
  }

  return {
    url: location.href,
    title: document.title,
    docHeight: document.documentElement.scrollHeight,
    viewport: window.innerWidth,
    elements,
    vars,
    fontFaces,
    media,
    animations,
    blockedSheets,
    truncated,
  };
}

/** Number every element once, so the capture pass and the style pass talk about the same nodes. */
export function tagElements(): number {
  let next = 0;
  for (const el of document.querySelectorAll("[data-dg-i]")) next = Math.max(next, Number(el.getAttribute("data-dg-i")) + 1);
  for (const el of document.querySelectorAll("body *")) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "BR"].includes(el.tagName)) continue;
    if (!el.hasAttribute("data-dg-i")) el.setAttribute("data-dg-i", String(next++));
  }
  return next;
}

export interface PaintRecord {
  readonly idx: number;
  /** Document coordinates (fixed elements: their place on the first screen). */
  readonly box: { x: number; y: number; w: number; h: number };
  readonly textBox?: { x: number; y: number; w: number; h: number };
  /** Share of the element inside the viewport and its clipping ancestors. */
  readonly inView: number;
  readonly painted: boolean;
  readonly fixed: boolean;
  /** Why it is not painted: transparent, clipped, covered, invisible-text. */
  readonly reason?: string;
}

/**
 * Which tagged elements are actually painted on the screen right now: effective
 * opacity through every ancestor, clipping by overflow ancestors, transparent
 * text, and whether something else covers them (hit test at three points).
 * This is what separates what the page's code contains from what a visitor sees
 * (scroll-reveal animations, background videos, overlays).
 */
export function paintCheck(): PaintRecord[] {
  const vw = window.innerWidth, vh = window.innerHeight, sy = window.scrollY;
  const opacityCache = new Map<Element, number>();
  const fixedCache = new Map<Element, boolean>();
  const clipCache = new Map<Element, { l: number; t: number; r: number; b: number }>();
  const effOpacity = (el: Element | null): number => {
    if (!el || el === document.documentElement) return 1;
    const c = opacityCache.get(el);
    if (c !== undefined) return c;
    const cs = getComputedStyle(el);
    const v = (cs.visibility === "hidden" || cs.display === "none" ? 0 : parseFloat(cs.opacity) || 0) * effOpacity(el.parentElement);
    opacityCache.set(el, v);
    return v;
  };
  const isFixed = (el: Element | null): boolean => {
    if (!el || el === document.body || el === document.documentElement) return false;
    const c = fixedCache.get(el);
    if (c !== undefined) return c;
    const v = getComputedStyle(el).position === "fixed" || isFixed(el.parentElement);
    fixedCache.set(el, v);
    return v;
  };
  // The visible window an element can paint into: the viewport cut by every overflow-clipping ancestor.
  const clipOf = (el: Element | null): { l: number; t: number; r: number; b: number } => {
    if (!el || el === document.body || el === document.documentElement) return { l: 0, t: 0, r: vw, b: vh };
    const c = clipCache.get(el);
    if (c) return c;
    const parent = clipOf(el.parentElement);
    const cs = getComputedStyle(el);
    let v = parent;
    if (/(hidden|clip|scroll|auto)/.test(cs.overflowX + cs.overflowY) && el !== document.scrollingElement) {
      const r = el.getBoundingClientRect();
      v = { l: Math.max(parent.l, r.left), t: Math.max(parent.t, r.top), r: Math.min(parent.r, r.right), b: Math.min(parent.b, r.bottom) };
    }
    clipCache.set(el, v);
    return v;
  };
  const MEDIA = new Set(["IMG", "SVG", "VIDEO", "PICTURE", "CANVAS", "IFRAME"]);
  const seeThrough = (el: Element): boolean => {
    if (MEDIA.has(el.tagName.toUpperCase())) return false;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const clear = !bg || bg === "transparent" || /rgba\(.*,\s*0(\.0+)?\)$/.test(bg);
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
    return clear && cs.backgroundImage === "none" && !ownText;
  };
  const out: PaintRecord[] = [];
  for (const el of document.querySelectorAll("[data-dg-i]")) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.display === "contents") continue;
    const idx = Number(el.getAttribute("data-dg-i"));
    const fixed = isFixed(el);
    const clip = clipOf(el.parentElement);
    const vis = { l: Math.max(clip.l, rect.left), t: Math.max(clip.t, rect.top), r: Math.min(clip.r, rect.right), b: Math.min(clip.b, rect.bottom) };
    const visArea = Math.max(0, vis.r - vis.l) * Math.max(0, vis.b - vis.t);
    const inView = Math.round((visArea / (rect.width * rect.height)) * 100) / 100;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
    let textBox: PaintRecord["textBox"];
    if (ownText) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tr = range.getBoundingClientRect();
      if (tr.width >= 1 && tr.height >= 1) textBox = { x: Math.round(tr.x), y: Math.round(tr.y + (fixed ? 0 : sy)), w: Math.round(tr.width), h: Math.round(tr.height) };
    }
    let reason: string | undefined;
    if (effOpacity(el) < 0.15) reason = "transparent";
    else if (visArea < 4) reason = "clipped";
    else if (ownText && /rgba\(.*,\s*0(\.0\d*)?\)$/.test((cs as CSSStyleDeclaration & { webkitTextFillColor?: string }).webkitTextFillColor || cs.color) && !/text/.test(cs.backgroundClip + ((cs as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip ?? ""))) reason = "invisible-text";
    else if (ownText || MEDIA.has(el.tagName.toUpperCase())) {
      // Hit test across the visible part: covered by a visible, unrelated element means not seen.
      const yMid = (vis.t + vis.b) / 2;
      const xs = [vis.l + (vis.r - vis.l) * 0.2, (vis.l + vis.r) / 2, vis.l + (vis.r - vis.l) * 0.8];
      let ok = 0;
      for (const x of xs) {
        const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, x)), Math.min(vh - 1, Math.max(0, yMid)));
        if (!hit || hit === el || el.contains(hit) || hit.contains(el) || seeThrough(hit)) ok++;
      }
      if (ok < 2) reason = "covered";
    }
    out.push({
      idx,
      box: { x: Math.round(rect.x), y: Math.round(rect.y + (fixed ? 0 : sy)), w: Math.round(rect.width), h: Math.round(rect.height) },
      ...(textBox ? { textBox } : {}),
      inView,
      painted: !reason,
      fixed,
      ...(reason ? { reason } : {}),
    });
  }
  return out;
}

/**
 * After the first screen: hide what stays glued to the screen (fixed layers,
 * headers and badges stuck to an edge), so the stitched page shows it once.
 */
export function hideScreenChrome(): number {
  let n = 0;
  const vh = window.innerHeight;
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") {
      (el as HTMLElement).style.setProperty("opacity", "0", "important");
      n++;
    } else if (cs.position === "sticky") {
      const r = el.getBoundingClientRect();
      if (r.top <= 2 || r.bottom >= vh - 2) { (el as HTMLElement).style.setProperty("opacity", "0", "important"); n++; }
    }
  }
  return n;
}

/** Click the "accept" button of a cookie or consent layer, when one covers the page. */
export function dismissOverlays(): string[] {
  const re = /^(accept|accept all|accept cookies|allow|allow all|agree|i agree|got it|ok|okay|aceitar|aceitar todos|aceito|concordo|entendi|permitir|permitir todos|aceptar|ich stimme zu|alle akzeptieren|j'accepte|tout accepter)$/i;
  const clicked: string[] = [];
  for (const b of document.querySelectorAll("button, [role=button], a")) {
    const t = (b.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 30 || !re.test(t)) continue;
    let layer = false;
    for (let n: Element | null = b; n && n !== document.body; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") { layer = true; break; }
    }
    const r = b.getBoundingClientRect();
    if (!layer || r.width < 1) continue;
    (b as HTMLElement).click();
    clicked.push(t);
    if (clicked.length >= 2) break;
  }
  return clicked;
}

/** Text that says the page is a bot check or an error, not the site. */
export function interstitialProbe(): { title: string; text: string; length: number } {
  const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
  return { title: document.title, text: text.slice(0, 1500), length: text.length };
}

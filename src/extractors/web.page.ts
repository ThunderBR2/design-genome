/**
 * Runs inside the page (serialized by Playwright). Must stay self-contained:
 * no imports, no closures over module scope. Reads only what the browser itself
 * computed, so every value here is exact for the rendered viewport.
 */
export interface PageElement {
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

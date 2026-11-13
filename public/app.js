/* PHP Station frontend - vanilla JS, no external resources.
   Talks only to the local PHP Station server (same origin) and sends X-DevPanel-Token on every API call.
   All user data (paths, names, log text) is inserted with DOM APIs / textContent, never as HTML. */
(function () {
  'use strict';

  /* ===================== Test hooks: error capture (must run first) ===================== */
  const errorList = [];
  window.__devpanelErrors = errorList;

  function mirrorErrors() {
    const pre = document.getElementById('dp-errors');
    if (pre) pre.textContent = errorList.join('\n');
  }
  function recordError(msg) {
    try {
      errorList.push(String(msg).slice(0, 4000));
      mirrorErrors();
    } catch (e) { /* the error hook must never throw */ }
  }
  window.onerror = function (message, source, line, col, err) {
    recordError(err && err.stack ? err.stack : String(message) + ' @ ' + (source || '?') + ':' + (line || 0) + ':' + (col || 0));
    return false;
  };
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    recordError('Unhandled rejection: ' + ((r && (r.stack || r.message)) || String(r)));
  });
  document.addEventListener('securitypolicyviolation', (ev) => {
    recordError('CSP violation: ' + ev.violatedDirective + ' blocked=' + (ev.blockedURI || 'inline') +
      ' at ' + (ev.sourceFile || '') + ':' + (ev.lineNumber || 0));
  });

  /* ===================== Theme (applied before first paint) ===================== */
  const THEME_KEY = 'devpanel.theme';
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { window.localStorage.setItem(key, val); } catch (e) { /* storage blocked */ } }
  // Themes: "black" (default), "silver" (light) and "auto" (follows the system). Older names are mapped.
  const THEMES = ['black', 'silver', 'auto'];
  function normTheme(t) {
    if (t === 'dark') return 'black';
    if (t === 'light') return 'silver';
    return THEMES.includes(t) ? t : 'black';
  }

  let themePref = normTheme(lsGet(THEME_KEY));
  function effectiveTheme() {
    if (themePref !== 'auto') return themePref;
    return darkQuery && !darkQuery.matches ? 'silver' : 'black';
  }
  function applyTheme() {
    document.documentElement.dataset.theme = effectiveTheme();
    document.documentElement.dataset.themePref = themePref;
  }
  applyTheme();

  /* ===================== Language (applied before first paint) ===================== */
  // 'roman' = Roman Urdu (default), 'en' = English, 'ur' = Urdu script (RTL). Dictionary: public/i18n.js.
  const LANG_KEY = 'devpanel.lang';
  const LANGS = ['roman', 'en', 'ur'];
  const LANG_NATIVE = {roman: 'Roman Urdu', en: 'English', ur: 'اردو'};
  const LANG_SHORT = {roman: 'Roman', en: 'EN', ur: 'اردو'};
  // Credits (About card + sidebar footer). Only these facts are shown; nothing else is claimed.
  const X8CODE_URL = 'https://x8code.com';
  const APP_VERSION_FALLBACK = '1.1.0';
  const DICT = (window.DP_I18N && typeof window.DP_I18N === 'object') ? window.DP_I18N : {};
  function normLang(l) { return LANGS.includes(l) ? l : 'roman'; }
  let lang = normLang(lsGet(LANG_KEY));
  function applyLang() {
    const root = document.documentElement;
    root.lang = lang === 'ur' ? 'ur' : 'en';
    root.dir = lang === 'ur' ? 'rtl' : 'ltr';
    root.dataset.lang = lang;
  }
  applyLang();
  function lookup(key) {
    const d = DICT[lang];
    if (d && d[key] != null) return d[key];
    const r = DICT.roman;
    if (r && r[key] != null) return r[key];
    return null;
  }
  function hasT(key) { return lookup(key) != null; }
  /** t('key', {name}) -> localized text. Fallback: current language -> Roman Urdu -> the key itself.
   *  In Urdu every inserted value is wrapped in Unicode isolates so paths/ports/names keep their LTR order. */
  function t(key, params) {
    const s = lookup(key);
    const text = s == null ? key : String(s);
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) => {
      if (params[k] == null) return '';
      const v = String(params[k]);
      return lang === 'ur' && v ? '\u2068' + v + '\u2069' : v;
    });
  }
  /** Plural helper: uses '<key>.one' for 1 and '<key>.many' otherwise; {n} is always available. */
  function tn(key, n, params) { return t(key + (Number(n) === 1 ? '.one' : '.many'), Object.assign({n}, params || {})); }
  /**
   * Texts that come from the backend (warnings, errors, job steps) mix Urdu with paths, ports and commands.
   * In Urdu every Latin stretch (".env", "DB_PORT=3307", "MariaDB 10.4.18 · C:\xampp 8") is wrapped in Unicode
   * isolates so the right-to-left paragraph cannot reorder its pieces. Other languages: unchanged.
   */
  const ARABIC_CHARS = '\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF';
  const LATIN_STRETCH = new RegExp('[^\\s' + ARABIC_CHARS + '\\u2066-\\u2069]+(?:\\s+[^\\s' + ARABIC_CHARS + '\\u2066-\\u2069]+)*', 'g');
  const HAS_ARABIC = new RegExp('[' + ARABIC_CHARS + ']');
  const EDGE_LEAD = /^[\s\u2014\u2013,;:!?()"'«»]*/;
  const EDGE_TRAIL = /[\s\u2014\u2013,;:!?()"'«»]*$/;
  /** Isolate one technical value (size, port, path) inside Urdu text. */
  function iso(v) { return lang === 'ur' && v != null && v !== '' ? '\u2068' + v + '\u2069' : v; }
  function bidi(s) {
    if (lang !== 'ur' || s == null) return s;
    const str = String(s);
    if (!HAS_ARABIC.test(str) || str.includes('\u2068')) return str;
    return str.replace(LATIN_STRETCH, (m) => {
      const lead = EDGE_LEAD.exec(m)[0];
      const rest = m.slice(lead.length);
      const trail = EDGE_TRAIL.exec(rest)[0];
      const core = rest.slice(0, rest.length - trail.length);
      if (!core || !/[A-Za-z0-9]/.test(core)) return m;
      return lead + '\u2068' + core + '\u2069' + trail;
    });
  }

  if (darkQuery) {
    const onScheme = () => { if (themePref === 'auto') { applyTheme(); if (typeof updateThemeButton === 'function') updateThemeButton(); } };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onScheme);
    else if (darkQuery.addListener) darkQuery.addListener(onScheme);
  }

  /* ===================== DOM helpers ===================== */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BOOL_PROPS = new Set(['disabled', 'checked', 'hidden', 'selected', 'readOnly', 'required', 'multiple', 'open', 'indeterminate']);

  function appendChildren(el, children) {
    for (const c of children) {
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) appendChildren(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }
  function applyProps(el, props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v == null || (v === false && !BOOL_PROPS.has(key))) continue;
      switch (key) {
        case 'class': el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v); break;
        case 'text': el.textContent = String(v); break;
        case 'on': for (const ev of Object.keys(v)) if (v[ev]) el.addEventListener(ev, v[ev]); break;
        case 'dataset': for (const k of Object.keys(v)) if (v[k] != null) el.dataset[k] = String(v[k]); break;
        case 'style': for (const k of Object.keys(v)) el.style.setProperty(k, String(v[k])); break;
        case 'ref': v(el); break;
        case 'value': el.value = String(v); break;
        default:
          if (BOOL_PROPS.has(key)) el[key] = !!v;
          else el.setAttribute(key, v === true ? '' : String(v));
      }
    }
  }
  /** h('div', {class, on, dataset, ...attrs}, ...children) - children are appended before props (so select.value works). */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    appendChildren(el, children);
    if (props) applyProps(el, props);
    return el;
  }
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
    return el;
  }
  function byId(id) { return document.getElementById(id); }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\\]\[]/g, '\\$&'); }

  /* ===================== Icons (hand-drawn 24x24 stroke icons) ===================== */
  // Mini syntax: parts separated by '|'; 'c:cx,cy,r' = circle, 'r:x,y,w,h,rx' = rect, otherwise a path.
  const ICONS = {
    grid: 'r:3.5,3.5,7,7,2|r:13.5,3.5,7,7,2|r:3.5,13.5,7,7,2|r:13.5,13.5,7,7,2',
    inbox: 'M3 13h5l1.5 3h5L16 13h5|M5.6 5h12.8L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z',
    mail: 'r:3,5,18,14,2.5|M3.8 6.8l8.2 6 8.2-6',
    bug: 'r:7.5,8,9,12,4.5|M12 11v9|M7.5 13H4|M20 13h-3.5|M7.5 17H5|M19 17h-2.5|M9 8.5a3 3 0 0 1 6 0|M6.5 5.5l2 2|M17.5 5.5l-2 2',
    branch: 'c:6,5,2.2|c:6,19,2.2|c:18,7,2.2|M6 7.2v9.6|M18 9.2c0 4.3-5 4.3-11 7.6',
    phone: 'r:7,2.5,10,19,2.5|M11 18.5h2',
    db: 'M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3z|M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6|M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6',
    move: 'M4 8h13|M13 4l4 4-4 4|M20 16H7|M11 12l-4 4 4 4',
    cpu: 'r:6,6,12,12,2|r:9.5,9.5,5,5,1|M9 2.5v3|M15 2.5v3|M9 18.5v3|M15 18.5v3|M2.5 9h3|M2.5 15h3|M18.5 9h3|M18.5 15h3',
    sliders: 'M4 6h9|M17 6h3|c:15,6,2|M4 12h3|M11 12h9|c:9,12,2|M4 18h11|M19 18h1|c:17,18,2',
    refresh: 'M20 11a8 8 0 0 0-14.9-3.9L4 9|M4 4v5h5|M4 13a8 8 0 0 0 14.9 3.9L20 15|M20 20v-5h-5',
    sun: 'c:12,12,4|M12 2.5v2|M12 19.5v2|M4.9 4.9l1.4 1.4|M17.7 17.7l1.4 1.4|M2.5 12h2|M19.5 12h2|M4.9 19.1l1.4-1.4|M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    monitor: 'r:3,4,18,12,2|M8 20h8|M12 16v4',
    plus: 'M12 5v14|M5 12h14',
    search: 'c:11,11,6.5|M20 20l-4.2-4.2',
    play: 'M7.5 5.2v13.6a1 1 0 0 0 1.52.85l10.9-6.8a1 1 0 0 0 0-1.7L9.02 4.35A1 1 0 0 0 7.5 5.2z',
    stop: 'r:6,6,12,12,2.5',
    power: 'M12 3v8|M6.3 7.2a8 8 0 1 0 11.4 0',
    globe: 'c:12,12,9|M3 12h18|M12 3a14 14 0 0 1 0 18|M12 3a14 14 0 0 0 0 18',
    terminal: 'r:3,4,18,16,2.5|M7 9l3 3-3 3|M13 15h4',
    folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
    'folder-search': 'M20.5 11V9.7A2.5 2.5 0 0 0 18 7.2h-7.5L8.5 5H5.5A2.5 2.5 0 0 0 3 7.5v10A2.5 2.5 0 0 0 5.5 20H11|c:16.5,16.5,3|M21 21l-2.2-2.2',
    log: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5|M9 13h6|M9 17h6|M9 9h1.5',
    shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z|M9 12l2 2 4-4',
    code: 'M8 8l-4 4 4 4|M16 8l4 4-4 4|M13.5 5l-3 14',
    more: 'c:5,12,1.2|c:12,12,1.2|c:19,12,1.2',
    pencil: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z|M14 7l3 3',
    copy: 'r:8,8,12,12,2|M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
    x: 'M6 6l12 12|M18 6L6 18',
    alert: 'M10.3 4.2L2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z|M12 9v4.5|M12 17.2v.1',
    'alert-circle': 'c:12,12,9|M12 7.5v5.5|M12 16.3v.1',
    info: 'c:12,12,9|M12 11v5.5|M12 7.7v.1',
    'check-circle': 'c:12,12,9|M8 12.3l2.7 2.7L16 9.7',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    trash: 'M4 7h16|M10 11v6|M14 11v6|M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12|M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7',
    external: 'M14 4h6v6|M20 4l-9 9|M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
    'chevron-down': 'M6 9l6 6 6-6',
    'chevron-right': 'M9 6l6 6-6 6',
    key: 'c:8,15,4|M11 12l9-9|M16 7l3 3|M14 9l2 2',
    download: 'M12 4v11|M7 10l5 5 5-5|M5 20h14',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1|M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    clock: 'c:12,12,9|M12 7v5l3 2',
    server: 'r:3,4,18,7,2|r:3,13,18,7,2|M7 7.5h.01|M7 16.5h.01',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    eraser: 'M7 20h13|M4.6 15.4l9.9-9.9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 18H8.5z',
    user: 'c:12,8,4|M4 21a8 8 0 0 1 16 0',
    lock: 'r:5,11,14,10,2|M8 11V7a4 4 0 0 1 8 0v4',
    hash: 'M5 9h14|M5 15h14|M10 4l-2 16|M16 4l-2 16',
    list: 'M8 6h13|M8 12h13|M8 18h13|M3.5 6h.01|M3.5 12h.01|M3.5 18h.01',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
    arrow: 'M5 12h14|M13 6l6 6-6 6',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z|c:12,12,3',
    radar: 'c:12,12,9|c:12,12,5|M12 12l6-6',
    layers: 'M12 3l9 5-9 5-9-5z|M3 13l9 5 9-5',
    dot: 'c:12,12,2',
    package: 'M12 2.8l8.2 4.6v9.2L12 21.2l-8.2-4.6V7.4z|M3.9 7.5L12 12l8.1-4.5|M12 12v9.1|M7.9 5.1l8.2 4.6',
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5',
    'wand': 'M4 20L15 9|M13 7l4 4|M18 3v3|M16.5 4.5h3|M20 9v2|M19 10h2|M9 3v2|M8 4h2',
    translate: 'M3.5 5.5h9|M8 3.5v2|M10.5 5.5c-.6 3.4-2.9 6.5-6.5 8.3|M5.8 9.2c1.2 2.2 3.3 3.9 5.9 4.6|M12.5 20.5l4.2-10 4.3 10|M14 17h5.5',
    undo: 'M9 14L4 9l5-5|M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    share: 'c:18,5,2.6|c:6,12,2.6|c:18,19,2.6|M8.4 13.3l7.2 4.4|M15.6 6.3l-7.2 4.4',
    'import': 'M3 12h11|M10 8l4 4-4 4|M14 4h4.5A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14',
    users: 'c:9,8,3.5|M2.5 20a6.5 6.5 0 0 1 13 0|c:17.2,9,2.6|M16.4 14.1a5 5 0 0 1 5.1 5.4'
  };
  // Icons that point in the reading direction; they are mirrored in RTL (Urdu).
  const DIR_ICONS = new Set(['arrow', 'chevron-right']);

  function icon(name, cls) {
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false'
    });
    const classes = [cls, DIR_ICONS.has(name) ? 'icon-dir' : null].filter(Boolean).join(' ');
    if (classes) svg.setAttribute('class', classes);
    for (const part of (ICONS[name] || ICONS.dot).split('|')) {
      if (part.startsWith('c:')) {
        const [cx, cy, r] = part.slice(2).split(',');
        svg.appendChild(svgEl('circle', {cx, cy, r}));
      } else if (part.startsWith('r:')) {
        const [x, y, w, hh, rx] = part.slice(2).split(',');
        svg.appendChild(svgEl('rect', {x, y, width: w, height: hh, rx: rx || 0}));
      } else {
        svg.appendChild(svgEl('path', {d: part}));
      }
    }
    return svg;
  }

  let gradSeq = 0;
  // Brushed-silver (for the black theme) and graphite (for the silver theme) metal gradients.
  const METAL_STOPS = {
    silver: [['0', '#f7f7f9'], ['.3', '#cfd2d8'], ['.6', '#8f949d'], ['1', '#e6e8ec']],
    graphite: [['0', '#3a3d43'], ['.45', '#17181b'], ['.75', '#2a2c31'], ['1', '#0d0e10']]
  };
  function metalGradient(id, kind) {
    const lg = svgEl('linearGradient', {id, x1: '0', y1: '0', x2: '1', y2: '1'});
    for (const [offset, color] of METAL_STOPS[kind]) lg.appendChild(svgEl('stop', {offset, 'stop-color': color}));
    return lg;
  }
  /** Logo mark: a metal tile with a ">_" glyph. Both variants are drawn; CSS shows the one for the theme. */
  function brandMark(cls) {
    const base = 'dpg' + (++gradSeq);
    const svg = svgEl('svg', {viewBox: '0 0 32 32', class: cls || 'brand-mark', 'aria-hidden': 'true', focusable: 'false'});
    const defs = svgEl('defs');
    defs.appendChild(metalGradient(base + 's', 'silver'));
    defs.appendChild(metalGradient(base + 'g', 'graphite'));
    svg.appendChild(defs);
    const variants = [['bm-silver', base + 's', '#0b0c0e'], ['bm-graphite', base + 'g', '#e6e8ec']];
    for (const [klass, gid, ink] of variants) {
      const g = svgEl('g', {class: klass});
      g.appendChild(svgEl('rect', {width: '32', height: '32', rx: '9', fill: 'url(#' + gid + ')'}));
      g.appendChild(svgEl('rect', {x: '.5', y: '.5', width: '31', height: '31', rx: '8.5', fill: 'none', stroke: '#ffffff', 'stroke-opacity': '.35'}));
      g.appendChild(svgEl('path', {
        d: 'M9.5 11l5 5-5 5M17 21.5h6', fill: 'none', stroke: ink, 'stroke-width': '2.6',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }));
      svg.appendChild(g);
    }
    return svg;
  }

  /** Friendly empty-state illustration: floating cards + a metal badge with an icon. */
  function illustration(name) {
    const base = 'dpi' + (++gradSeq);
    const svg = svgEl('svg', {viewBox: '0 0 172 128', class: 'illus', 'aria-hidden': 'true', focusable: 'false'});
    const defs = svgEl('defs');
    defs.appendChild(metalGradient(base + 's', 'silver'));
    defs.appendChild(metalGradient(base + 'g', 'graphite'));
    svg.appendChild(defs);
    svg.appendChild(svgEl('ellipse', {class: 'i-glow', cx: '86', cy: '70', rx: '74', ry: '48'}));
    const back = svgEl('g', {class: 'float-b'});
    back.appendChild(svgEl('rect', {class: 'i-card-back', x: '46', y: '18', width: '92', height: '62', rx: '12', transform: 'rotate(-7 92 49)'}));
    svg.appendChild(back);
    const front = svgEl('g', {class: 'float-a'});
    front.appendChild(svgEl('rect', {class: 'i-card', x: '28', y: '38', width: '112', height: '70', rx: '14'}));
    front.appendChild(svgEl('rect', {class: 'i-line accent', x: '44', y: '56', width: '48', height: '7', rx: '3.5'}));
    front.appendChild(svgEl('rect', {class: 'i-line', x: '44', y: '71', width: '76', height: '7', rx: '3.5'}));
    front.appendChild(svgEl('rect', {class: 'i-line', x: '44', y: '86', width: '36', height: '7', rx: '3.5'}));
    svg.appendChild(front);
    svg.appendChild(svgEl('circle', {class: 'i-badge bm-silver', cx: '134', cy: '38', r: '19', fill: 'url(#' + base + 's)'}));
    svg.appendChild(svgEl('circle', {class: 'i-badge bm-graphite', cx: '134', cy: '38', r: '19', fill: 'url(#' + base + 'g)'}));
    const ic = icon(name, 'i-icon');
    ic.setAttribute('x', '123');
    ic.setAttribute('y', '27');
    ic.setAttribute('width', '22');
    ic.setAttribute('height', '22');
    svg.appendChild(ic);
    svg.appendChild(svgEl('circle', {class: 'i-dot', cx: '22', cy: '34', r: '4'}));
    svg.appendChild(svgEl('circle', {class: 'i-dot', cx: '156', cy: '96', r: '3'}));
    svg.appendChild(svgEl('circle', {class: 'i-dot', cx: '16', cy: '96', r: '2.5'}));
    return svg;
  }

  /* ===================== Formatting & validation ===================== */
  function parseTime(t) {
    if (t == null || t === '') return NaN;
    if (typeof t === 'number') return t;
    return Date.parse(t);
  }
  function durationText(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return t('time.fewSec');
    const m = Math.floor(s / 60);
    if (m < 60) return t('time.min', {n: m});
    const hr = Math.floor(m / 60);
    const rm = m % 60;
    if (hr < 24) return rm ? t('time.hoursMin', {h: hr, m: rm}) : t('time.hours', {h: hr});
    return tn('time.days', Math.floor(hr / 24));
  }
  function sinceText(v0) {
    const v = parseTime(v0);
    return isNaN(v) ? '' : t('time.since', {d: durationText(Date.now() - v)});
  }
  function agoText(v0) {
    const v = parseTime(v0);
    if (isNaN(v)) return '';
    const s = Math.floor((Date.now() - v) / 1000);
    if (s < 45) return t('time.justNow');
    return t('time.ago', {d: durationText(Date.now() - v)});
  }
  function clockTime(t) {
    const v = parseTime(t);
    if (isNaN(v)) return '';
    const d = new Date(v);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtBytes(b) {
    const n = Number(b);
    if (b == null || !isFinite(n)) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0)) + ' ' + units[i];
  }
  function fmtMB(mb) {
    const n = Number(mb);
    if (mb == null || !isFinite(n)) return '-';
    if (n < 0.1) return '< 0.1 MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' GB';
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' MB';
  }
  function fmtInt(n) {
    const v = Number(n);
    return isFinite(v) ? v.toLocaleString('en-US') : '-';
  }
  function versionFamily(v) {
    const m = /(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? m[1] + '.' + m[2] : '';
  }
  const FAMILY_CLASS = {'8.5': 'fam-0', '8.4': 'fam-1', '8.3': 'fam-2', '8.2': 'fam-3', '8.1': 'fam-4', '8.0': 'fam-5', '7.4': 'fam-6'};
  function famClass(v) { return FAMILY_CLASS[versionFamily(v)] || 'fam-7'; }
  function baseName(p) {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function normPath(p) { return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); }
  function safeId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }
  let uidSeq = 0;
  function uid(prefix) { return (prefix || 'dp') + '-' + (++uidSeq); }
  function enc(s) { return encodeURIComponent(String(s)); }
  function debounce(fn, ms) {
    let t = null;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
  }
  const PATH_BAD_CHARS = /["%!^&|<>\r\n]/;
  function validateWinPath(p) {
    const v = String(p || '').trim();
    if (!v) return t('path.empty');
    if (!/^[A-Za-z]:[\\/]/.test(v)) return t('path.notAbs');
    if (v.length >= 240) return t('path.tooLong');
    if (PATH_BAD_CHARS.test(v)) return t('path.badChars');
    return null;
  }
  function validPort(v, min, max) {
    const n = Number(v);
    return Number.isInteger(n) && n >= (min || 1024) && n <= (max || 65535) ? n : null;
  }

  /* ===================== Small UI atoms ===================== */
  function spinner() { return h('span', {class: 'spinner', 'aria-hidden': 'true'}); }

  /** Button factory. opts: kind, size, icon, iconOnly, title, onClick, disabled, fk, className, attrs */
  function btn(label, opts) {
    const o = opts || {};
    const cls = ['btn'];
    if (o.kind) cls.push('btn-' + o.kind);
    if (o.size) cls.push('btn-' + o.size);
    if (o.iconOnly) cls.push('btn-icon');
    if (o.className) cls.push(o.className);
    const b = h('button', Object.assign({
      type: 'button', class: cls,
      title: o.title || (o.iconOnly ? label : null),
      'aria-label': o.iconOnly ? label : (o.ariaLabel || null),
      disabled: !!o.disabled,
      dataset: o.fk ? {fk: o.fk} : null
    }, o.attrs || {}), o.icon ? icon(o.icon) : null, o.iconOnly ? null : h('span', {class: 'btn-label'}, label));
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
  }
  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    const label = button.querySelector('.btn-label');
    if (busy) {
      if (button.classList.contains('is-busy')) return;
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      button.insertBefore(spinner(), button.firstChild);
      if (busyLabel && label) { button.dataset.label = label.textContent; label.textContent = busyLabel; }
    } else {
      button.classList.remove('is-busy');
      button.removeAttribute('aria-busy');
      button.disabled = false;
      const sp = button.querySelector(':scope > .spinner');
      if (sp) sp.remove();
      if (button.dataset.label != null && label) { label.textContent = button.dataset.label; delete button.dataset.label; }
    }
  }
  /** chip(text, {kind, fam, mono, lg, cls, icon, dot, title, onClick, ariaLabel}) */
  function chip(text, opts) {
    const o = opts || {};
    const cls = ['chip'];
    if (o.kind) cls.push('chip-' + o.kind);
    if (o.fam) cls.push('chip-ver', o.fam);
    if (o.mono) cls.push('chip-mono');
    if (o.lg) cls.push('chip-lg');
    if (o.cls) cls.push(o.cls);
    const isBtn = !!o.onClick;
    const el = h(isBtn ? 'button' : 'span', {
      class: cls, type: isBtn ? 'button' : null, title: o.title || null, 'aria-label': o.ariaLabel || null
    }, o.icon ? icon(o.icon) : null, o.dot ? h('span', {class: ['dot'].concat(o.dot.split(' '))}) : null, h('span', null, text));
    if (isBtn) el.addEventListener('click', o.onClick);
    return el;
  }
  function callout(kind, title, body, actions) {
    const iconName = {warn: 'alert', bad: 'alert-circle', info: 'info', ok: 'check-circle'}[kind] || 'info';
    return h('div', {class: ['callout', 'callout-' + kind]},
      icon(iconName, 'callout-icon'),
      h('div', {class: 'callout-body'},
        title ? h('div', {class: 'callout-title'}, title) : null,
        body == null ? null : (body instanceof Node ? body : h('div', null, String(body))),
        actions && actions.length ? h('div', {class: 'callout-actions'}, actions) : null));
  }
  function emptyState(o) {
    return h('div', {class: ['empty', o.small && 'empty-sm']},
      illustration(o.icon || 'sparkle'),
      h('h3', {class: 'empty-title'}, o.title),
      o.text ? h('p', {class: 'empty-text'}, o.text) : null,
      o.actions && o.actions.length ? h('div', {class: 'empty-actions'}, o.actions) : null);
  }
  /** Accessible switch: a <button role="switch"> (Space/Enter work natively). */
  function makeSwitch(o) {
    const sw = h('button', {
      type: 'button', class: ['switch', o.size ? 'switch-' + o.size : null, o.busy && 'is-busy'],
      role: 'switch', 'aria-checked': o.checked ? 'true' : 'false', 'aria-label': o.label,
      'aria-busy': o.busy ? 'true' : null, title: o.title || o.label, disabled: !!o.disabled,
      dataset: o.fk ? {fk: o.fk} : null
    }, h('span', {class: 'switch-track'}), h('span', {class: 'switch-thumb'}, o.busy ? spinner() : null));
    if (o.onToggle) {
      sw.addEventListener('click', () => {
        if (sw.disabled || sw.classList.contains('is-busy')) return;
        o.onToggle(sw.getAttribute('aria-checked') !== 'true', sw);
      });
    }
    if (!o.text) return sw;
    return h('span', {class: 'switch-wrap'}, h('span', {class: 'switch-text', 'aria-hidden': 'true'}, o.text), sw);
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall back below */ }
    try {
      const ta = h('textarea', {class: 'sr-only', readonly: 'readonly'});
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  function copyButton(text, label) {
    const title = label || t('copy.do');
    const b = h('button', {type: 'button', class: 'copy-btn', title, 'aria-label': title}, icon('copy'));
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (await copyText(String(text))) {
        b.replaceChildren(icon('check'));
        b.classList.add('is-done');
        b.title = t('copy.done');
        setTimeout(() => { b.replaceChildren(icon('copy')); b.classList.remove('is-done'); b.title = title; }, 1400);
      } else {
        toast('warn', t('copy.fail'), t('copy.failHint'));
      }
    });
    return b;
  }

  /* ===================== Toasts & banners ===================== */
  const TOAST_ICON = {success: 'check-circle', warn: 'alert', error: 'alert-circle', info: 'info'};
  function toast(kind, title, message, opts) {
    const o = opts || {};
    const root = byId('toasts');
    if (!root) return {close() {}};
    const duration = o.duration || 5000;
    let closed = false;
    let timer = null;
    let remaining = duration;
    let started = 0;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 220);
    };
    const actions = (o.actions || []).map((a) => btn(a.label, {size: 'sm', kind: a.kind, onClick: () => { close(); a.onClick(); }}));
    const closeBtn = btn(t('common.close'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'x', className: 'toast-close', onClick: close});
    const bar = h('span', {class: 'toast-bar', 'aria-hidden': 'true'});
    bar.style.animationDuration = duration + 'ms';
    const el = h('div', {class: ['toast', 'toast-' + kind], role: kind === 'error' ? 'alert' : 'status'},
      h('span', {class: 'toast-icon'}, icon(TOAST_ICON[kind] || 'info')),
      h('div', {class: 'toast-body'},
        h('div', {class: 'toast-title'}, title),
        message ? h('div', {class: 'toast-msg'}, String(message)) : null,
        actions.length ? h('div', {class: 'toast-actions'}, actions) : null),
      closeBtn, bar);
    const arm = () => { clearTimeout(timer); started = Date.now(); timer = setTimeout(close, remaining); };
    const pause = () => { clearTimeout(timer); remaining = Math.max(900, remaining - (Date.now() - started)); };
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', arm);
    el.addEventListener('focusin', pause);
    el.addEventListener('focusout', arm);
    root.appendChild(el);
    while (root.children.length > 5) root.firstElementChild.remove();
    arm();
    return {close};
  }

  const banners = new Map();
  function showBanner(key, kind, text, action) {
    const slot = byId('banner-slot');
    if (!slot) return;
    hideBanner(key);
    const el = h('div', {class: ['banner', kind === 'bad' ? 'banner-bad' : kind === 'info' ? 'banner-info' : null]},
      icon(kind === 'info' ? 'info' : kind === 'bad' ? 'alert-circle' : 'alert'),
      h('span', {class: 'grow'}, text),
      action ? btn(action.label, {size: 'sm', icon: action.icon, onClick: action.onClick}) : null);
    banners.set(key, el);
    slot.appendChild(el);
  }
  function hideBanner(key) {
    const el = banners.get(key);
    if (el) { el.remove(); banners.delete(key); }
  }

  /* ===================== API ===================== */
  function getToken() {
    const m = document.querySelector('meta[name="devpanel-token"]');
    return m ? m.getAttribute('content') || '' : '';
  }
  // Fallback texts per error code (used only when the backend sent no message).
  function codeText(code) { return code && hasT('code.' + code) ? t('code.' + code) : null; }
  function errorText(r, fallback) {
    if (r && typeof r.error === 'string' && r.error.trim()) return bidi(r.error);
    const c = r && codeText(r.code);
    if (c) return c;
    return fallback || t('err.generic');
  }
  /** Every call resolves (never rejects) to the parsed JSON, or {ok:false, code, error}. */
  async function api(method, path, body) {
    const headers = {'X-DevPanel-Token': getToken(), Accept: 'application/json'};
    const init = {method, headers, cache: 'no-store', credentials: 'same-origin'};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body == null ? {} : body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      return {ok: false, code: 'NETWORK', error: codeText('NETWORK')};
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401 && (!data || !data.code || data.code === 'BAD_TOKEN')) {
      handleUnauthorized();
      return {ok: false, code: 'BAD_TOKEN', error: codeText('BAD_TOKEN')};
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {ok: false, code: 'BAD_RESPONSE', error: codeText('BAD_RESPONSE') + ' (HTTP ' + res.status + ')'};
    }
    if (!res.ok) {
      if (data.ok !== false) data = Object.assign({}, data, {ok: false});
      if (!data.code) data.code = 'HTTP_' + res.status;
    } else if (data.ok === undefined) {
      data.ok = true;
    }
    return data;
  }

  let authFailed = false;
  function handleUnauthorized() {
    if (authFailed) return;
    authFailed = true;
    stopPolling();
    let last = 0;
    try { last = Number(window.sessionStorage.getItem('devpanel.reloadAt')) || 0; } catch (e) { last = 0; }
    const canReload = Date.now() - last > 30000;
    if (canReload) {
      showBanner('auth', 'bad', t('auth.reloading'));
      try { window.sessionStorage.setItem('devpanel.reloadAt', String(Date.now())); } catch (e) { /* ignore */ }
      setTimeout(() => window.location.reload(), 1200);
    } else {
      showBanner('auth', 'bad', t('auth.reloadNow'), {label: t('auth.reloadBtn'), icon: 'refresh', onClick: () => window.location.reload()});
    }
  }

  /* ===================== Modals ===================== */
  const modalStack = [];
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  function focusables(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
  }
  function focusFirst(container, preferBody) {
    const auto = container.querySelector('[data-autofocus]');
    let target = auto && !auto.disabled ? auto : null;
    if (!target && preferBody) target = focusables(preferBody)[0] || null;
    if (!target) target = container;
    try { target.focus({preventScroll: true}); } catch (e) { /* element may be gone */ }
  }
  function trapTab(ev, root) {
    const list = focusables(root);
    if (!list.length) { ev.preventDefault(); root.focus(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || !root.contains(active))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (active === last || !root.contains(active))) { ev.preventDefault(); first.focus(); }
  }
  function syncInert() {
    const hasModal = modalStack.length > 0;
    const app = byId('app');
    if (app) app.inert = hasModal || !!drawerState;
    const dr = byId('drawer-root');
    if (dr) dr.inert = hasModal;
    modalStack.forEach((m, i) => { m.backdrop.inert = i < modalStack.length - 1; });
  }

  /**
   * openModal({title, subtitle, icon, tone, size, body, actions, dismissible, onClose, className, alert})
   * actions: [{id, label, kind, icon, value, onClick(ctrl, button), autofocus, left, disabled}]
   * Returns ctrl {el, body, close(result), setActions, button(id), setBusy, result:Promise}
   */
  function openModal(o) {
    closeMenu();
    const opener = document.activeElement;
    const titleId = uid('mt');
    const subId = uid('ms');
    const dismissible = o.dismissible !== false;
    const closeX = dismissible ? btn(t('common.close'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'x'}) : null;
    const subEl = h('p', {class: 'modal-sub', id: subId, hidden: !o.subtitle}, o.subtitle || '');
    const head = h('div', {class: 'modal-head'},
      o.icon ? h('div', {class: ['modal-icon', o.tone ? 'is-' + o.tone : null]}, icon(o.icon)) : null,
      h('div', {class: 'modal-titles'}, h('h2', {class: 'modal-title', id: titleId}, o.title), subEl),
      closeX);
    const body = h('div', {class: 'modal-body'});
    if (o.body) appendChildren(body, [o.body]);
    const foot = h('div', {class: 'modal-foot'});
    const dialog = h('div', {
      class: ['modal', 'modal-' + (o.size || 'md'), o.className], role: o.alert ? 'alertdialog' : 'dialog',
      'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': o.subtitle ? subId : null, tabindex: '-1'
    }, head, body, foot);
    const backdrop = h('div', {class: 'modal-backdrop'}, dialog);
    let resolveResult;
    const ctrl = {
      el: dialog, body, foot, backdrop, dismissible, busy: false, closed: false,
      result: new Promise((resolve) => { resolveResult = resolve; }),
      setSubtitle(text) { subEl.textContent = text || ''; subEl.hidden = !text; },
      setActions(actions) {
        foot.replaceChildren();
        for (const a of actions || []) {
          if (!a) continue;
          const b = btn(a.label, {kind: a.kind, icon: a.icon, disabled: a.disabled, className: a.left ? 'left' : null});
          if (a.autofocus) b.dataset.autofocus = '1';
          if (a.id) b.dataset.action = a.id;
          b.addEventListener('click', () => { if (a.onClick) a.onClick(ctrl, b); else ctrl.close(a.value); });
          foot.appendChild(b);
        }
        foot.hidden = foot.children.length === 0;
      },
      button(id) { return foot.querySelector('[data-action="' + cssEsc(id) + '"]'); },
      setBusy(b) { ctrl.busy = !!b; if (closeX) closeX.disabled = !!b; },
      close(result) {
        if (ctrl.closed) return;
        ctrl.closed = true;
        const i = modalStack.indexOf(ctrl);
        if (i >= 0) modalStack.splice(i, 1);
        backdrop.classList.remove('is-open');
        setTimeout(() => backdrop.remove(), 200);
        syncInert();
        if (o.onClose) {
          try { o.onClose(result); } catch (e) { recordError(e && e.stack ? e.stack : String(e)); }
        }
        resolveResult(result);
        const top = modalStack[modalStack.length - 1];
        if (top) focusFirst(top.el, top.body);
        else if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({preventScroll: true});
      }
    };
    if (closeX) closeX.addEventListener('click', () => { if (!ctrl.busy) ctrl.close(); });
    let downOnBackdrop = false;
    backdrop.addEventListener('mousedown', (ev) => { downOnBackdrop = ev.target === backdrop; });
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop && downOnBackdrop && dismissible && !ctrl.busy) ctrl.close();
    });
    ctrl.setActions(o.actions);
    byId('modal-root').appendChild(backdrop);
    modalStack.push(ctrl);
    syncInert();
    void backdrop.offsetWidth; // flush styles so the open transition runs
    backdrop.classList.add('is-open');
    focusFirst(dialog, body);
    return ctrl;
  }

  /** Yes/No dialog. Resolves true only when the confirm button was pressed. */
  function confirmDialog(o) {
    const m = openModal({
      title: o.title, subtitle: o.subtitle, icon: o.icon || (o.danger ? 'alert' : 'info'),
      tone: o.tone || (o.danger ? 'bad' : null), size: o.size || 'sm', alert: true,
      body: [o.message ? h('p', {class: 'modal-text'}, o.message) : null, o.details || null],
      actions: [
        {label: o.cancelLabel || t('common.no'), value: false, autofocus: !!o.danger},
        {label: o.confirmLabel || t('common.yes'), kind: o.danger ? 'danger' : 'primary', icon: o.confirmIcon || null, value: true, autofocus: !o.danger}
      ]
    });
    return m.result.then((v) => v === true);
  }

  /** Single input dialog. Resolves the trimmed string, or null on cancel. */
  function promptDialog(o) {
    const inputId = uid('pi');
    const input = h('input', {
      class: ['input', o.mono && 'mono'], id: inputId, type: o.type || 'text', value: o.value != null ? o.value : '',
      placeholder: o.placeholder || null, autocomplete: 'off', spellcheck: 'false', inputmode: o.inputmode || null,
      min: o.min != null ? o.min : null, max: o.max != null ? o.max : null, dataset: {autofocus: '1'}
    });
    const err = h('div', {class: 'field-error', 'aria-live': 'polite'});
    let m = null;
    const submit = () => {
      const v = input.value.trim();
      const problem = o.validate ? o.validate(v) : null;
      if (problem) { err.textContent = problem; input.classList.add('is-invalid'); input.focus(); return; }
      m.close(v);
    };
    m = openModal({
      title: o.title, subtitle: o.subtitle, icon: o.icon || 'pencil', size: 'sm',
      body: [o.before || null, h('div', {class: 'field'},
        h('label', {class: 'field-label', for: inputId}, o.label),
        input, o.hint ? h('div', {class: 'field-hint'}, o.hint) : null, err)],
      actions: [{label: t('common.cancel'), value: null}, {label: o.confirmLabel || t('common.save'), kind: 'primary', icon: 'check', onClick: submit}]
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    input.addEventListener('input', () => { err.textContent = ''; input.classList.remove('is-invalid'); });
    if (o.selectAll !== false) setTimeout(() => { try { input.select(); } catch (e) { /* number inputs */ } }, 0);
    return m.result.then((v) => (typeof v === 'string' ? v : null));
  }

  /** Ask for DB user/password. The password lives only in this call's memory. */
  function askCredentials(o) {
    const uId = uid('cu');
    const pId = uid('cp');
    const user = h('input', {class: 'input', id: uId, type: 'text', value: o.user || 'root', autocomplete: 'off', spellcheck: 'false', dataset: {autofocus: '1'}});
    const pass = h('input', {class: 'input', id: pId, type: 'password', autocomplete: 'new-password', placeholder: t('cred.passPh')});
    const reveal = btn(t('cred.show'), {kind: 'ghost', iconOnly: true, icon: 'eye'});
    reveal.addEventListener('click', () => {
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      reveal.title = show ? t('cred.hide') : t('cred.show');
      reveal.setAttribute('aria-label', reveal.title);
    });
    const err = h('div', {class: 'field-error', 'aria-live': 'polite'});
    let m = null;
    const submit = () => {
      const u = user.value.trim();
      if (!u) { err.textContent = t('cred.userReq'); user.focus(); return; }
      const result = {user: u, password: pass.value};
      pass.value = '';
      m.close(result);
    };
    m = openModal({
      title: o.title || t('cred.title'), subtitle: o.subtitle, icon: 'key', tone: 'warn', size: 'sm',
      body: [
        o.message ? callout('info', null, o.message) : null,
        h('div', {class: 'field'}, h('label', {class: 'field-label', for: uId}, t('cred.user')), user),
        h('div', {class: 'field'}, h('label', {class: 'field-label', for: pId}, t('cred.password')), h('div', {class: 'input-row'}, pass, reveal), err),
        h('p', {class: 'field-hint'}, t('cred.hint'))
      ],
      actions: [{label: t('common.cancel'), value: null}, {label: o.confirmLabel || t('cred.next'), kind: 'primary', icon: 'arrow', onClick: submit}]
    });
    for (const inp of [user, pass]) inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    return m.result.then((v) => (v && typeof v === 'object' ? v : null));
  }

  /* ===================== Log drawer ===================== */
  let drawerState = null;

  function lineClass(line) {
    const l = line.toLowerCase();
    if (/^\s*=====/.test(line)) return 'ln-head';
    if (/\b(fatal|error|exception|failed|crash|aborting)\b|\[error\]|\[err\]/.test(l)) return 'ln-err';
    if (/\b(warn|warning|deprecated|notice)\b|\[warning\]|\[note\]/.test(l)) return 'ln-warn';
    if (/ready for connections|shutdown complete|development server|server running|listening on|accepted/.test(l)) return 'ln-ok';
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) return 'ln-dim';
    return null;
  }
  function renderLogText(term, text, autoScroll) {
    if (term.__dpText === text) return;
    term.__dpText = text;
    if (!text || !text.trim()) {
      term.replaceChildren(h('span', {class: 'term-empty'}, t('log.empty')));
      return;
    }
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const frag = document.createDocumentFragment();
    for (const line of lines) frag.appendChild(h('span', {class: ['ln', lineClass(line)]}, line || ' '));
    term.replaceChildren(frag);
    if (autoScroll) term.scrollTop = term.scrollHeight;
  }

  /** openDrawer({title, subtitle, icon, fetch: async () => ({ok, text, size, subtitle, error}), onClear}) */
  function openDrawer(o) {
    closeDrawer(true);
    closeMenu();
    const opener = document.activeElement;
    const titleId = uid('dt');
    let autoScroll = true;
    let autoRefresh = true;
    let loading = false;
    const term = h('pre', {class: 'term', tabindex: '0', 'aria-label': t('log.aria'), dir: 'ltr'});
    const sub = h('p', {class: 'modal-sub mono', hidden: !o.subtitle}, o.subtitle || '');
    const meta = h('span', {class: 'muted small', 'aria-live': 'polite'}, t('common.loading'));
    const swScroll = makeSwitch({
      checked: true, size: 'sm', label: t('log.autoScroll'), text: t('log.autoScroll'),
      onToggle: (v, el) => { autoScroll = v; el.setAttribute('aria-checked', String(v)); if (v) term.scrollTop = term.scrollHeight; }
    });
    const swRefresh = makeSwitch({
      checked: true, size: 'sm', label: t('log.autoRefreshLabel'), text: t('log.autoRefresh'),
      onToggle: (v, el) => { autoRefresh = v; el.setAttribute('aria-checked', String(v)); }
    });
    const refreshBtn = btn(t('log.refreshNow'), {size: 'sm', iconOnly: true, icon: 'refresh'});
    const closeBtn = btn(t('common.close'), {kind: 'ghost', iconOnly: true, icon: 'x'});
    const clearBtn = o.onClear ? btn(t('log.clear'), {size: 'sm', kind: 'ghost', icon: 'eraser'}) : null;
    const panel = h('div', {class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1'},
      h('div', {class: 'drawer-head'},
        h('div', {class: 'modal-icon'}, icon(o.icon || 'log')),
        h('div', {class: 'modal-titles'}, h('h2', {class: 'modal-title', id: titleId}, o.title), sub),
        closeBtn),
      h('div', {class: 'drawer-tools'}, swScroll, swRefresh, h('span', {class: 'spacer'}), meta, clearBtn, refreshBtn),
      term);
    const backdrop = h('div', {class: 'drawer-backdrop'});
    const root = byId('drawer-root');
    root.append(backdrop, panel);

    const load = async (manual) => {
      if (loading) return;
      loading = true;
      if (manual) refreshBtn.classList.add('is-spinning');
      const r = await o.fetch();
      loading = false;
      refreshBtn.classList.remove('is-spinning');
      if (!drawerState || drawerState.panel !== panel) return;
      if (!r || !r.ok) { meta.textContent = errorText(r, t('log.loadFail')); return; }
      renderLogText(term, typeof r.text === 'string' ? r.text : '', autoScroll);
      if (r.subtitle) { sub.textContent = r.subtitle; sub.hidden = false; }
      meta.textContent = (r.size != null ? iso(fmtBytes(r.size)) + ' · ' : '') + t('log.updated', {time: clockTime(Date.now())});
    };
    refreshBtn.addEventListener('click', () => load(true));
    closeBtn.addEventListener('click', () => closeDrawer());
    backdrop.addEventListener('click', () => closeDrawer());
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        const yes = await confirmDialog({
          title: t('log.clearQ'), message: t('log.clearMsg'),
          confirmLabel: t('log.clearYes'), icon: 'eraser'
        });
        if (!yes) return;
        setBusy(clearBtn, true);
        const r = await o.onClear();
        setBusy(clearBtn, false);
        if (r && r.ok) { term.__dpText = null; toast('success', t('log.cleared')); load(true); }
        else toast('error', t('log.clearFail'), errorText(r));
      });
    }
    const timer = setInterval(() => { if (autoRefresh && !document.hidden) load(false); }, 2000);
    drawerState = {panel, backdrop, opener, timer};
    syncInert();
    void panel.offsetWidth;
    panel.classList.add('is-open');
    backdrop.classList.add('is-open');
    closeBtn.focus({preventScroll: true});
    load(true);
  }
  function closeDrawer(immediate) {
    const st = drawerState;
    if (!st) return;
    drawerState = null;
    clearInterval(st.timer);
    st.panel.classList.remove('is-open');
    st.backdrop.classList.remove('is-open');
    const remove = () => { st.panel.remove(); st.backdrop.remove(); };
    if (immediate) remove(); else setTimeout(remove, 300);
    syncInert();
    if (!immediate && st.opener && st.opener.isConnected) st.opener.focus({preventScroll: true});
  }

  /* ===================== Popover menus ===================== */
  let menuState = null;

  /** openMenu(anchorButton, [{label, icon, hint, danger, disabled, title, onClick} | 'sep' | {heading}], {label}) */
  function openMenu(anchor, items, o) {
    if (menuState && menuState.anchor === anchor) { closeMenu(true); return; }
    closeMenu();
    const menu = h('div', {class: 'menu', role: 'menu', 'aria-label': (o && o.label) || null});
    for (const it of items) {
      if (!it) continue;
      if (it === 'sep') { menu.appendChild(h('div', {class: 'menu-sep', role: 'separator'})); continue; }
      if (it.heading) { menu.appendChild(h('div', {class: 'menu-label', role: 'presentation'}, it.heading)); continue; }
      const radio = it.checked != null;
      const b = h('button', {
        type: 'button', class: ['menu-item', it.danger && 'is-danger', radio && 'is-radio'], role: radio ? 'menuitemradio' : 'menuitem',
        'aria-checked': radio ? String(!!it.checked) : null, disabled: !!it.disabled, title: it.title || null
      },
      it.icon ? icon(it.icon) : null,
      h('span', {lang: it.lang || null, dir: it.dir || null}, it.label),
      it.hint ? h('span', {class: 'menu-hint'}, it.hint) : null,
      radio ? h('span', {class: 'menu-check', 'aria-hidden': 'true'}, it.checked ? icon('check') : null) : null);
      b.addEventListener('click', () => { closeMenu(true); it.onClick(); });
      menu.appendChild(b);
    }
    menu.addEventListener('keydown', (ev) => {
      const list = Array.from(menu.querySelectorAll('.menu-item:not(:disabled)'));
      const i = list.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); (list[(i + 1) % list.length] || list[0]).focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); (list[(i - 1 + list.length) % list.length] || list[0]).focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); if (list[0]) list[0].focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); if (list.length) list[list.length - 1].focus(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(true); }
      else if (ev.key === 'Tab') { closeMenu(false); }
    });
    byId('menu-root').appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    // LTR: the menu's right edge lines up with the button; RTL (Urdu): its left edge does.
    let left;
    if (lang === 'ur') {
      left = r.left;
      if (left + mw > window.innerWidth - 8) left = Math.max(8, r.right - mw);
    } else {
      left = r.right - mw;
      if (left < 8) left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    }
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    menuState = {menu, anchor};
    const first = menu.querySelector('.menu-item:not(:disabled)');
    if (first) first.focus({preventScroll: true});
  }
  function closeMenu(returnFocus) {
    const st = menuState;
    if (!st) return;
    menuState = null;
    st.menu.remove();
    if (st.anchor.isConnected) {
      st.anchor.setAttribute('aria-expanded', 'false');
      if (returnFocus) st.anchor.focus({preventScroll: true});
    }
    if (S.deferred) setTimeout(flushDeferred, 0);
  }
  /** A small icon button that opens a menu. */
  function menuButton(label, iconName, itemsFn, opts) {
    const o = opts || {};
    const b = btn(label, {kind: o.kind || 'ghost', size: o.size || 'sm', iconOnly: !o.withText, icon: iconName, title: label, fk: o.fk, disabled: o.disabled});
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => openMenu(b, itemsFn(), {label}));
    return b;
  }

  document.addEventListener('mousedown', (ev) => {
    if (menuState && !menuState.menu.contains(ev.target) && !menuState.anchor.contains(ev.target)) closeMenu(false);
  });
  window.addEventListener('resize', () => closeMenu(false));
  window.addEventListener('scroll', () => closeMenu(false), true);

  document.addEventListener('keydown', (ev) => {
    const top = modalStack[modalStack.length - 1];
    if (top) {
      if (ev.key === 'Escape' && top.dismissible && !top.busy) { ev.preventDefault(); top.close(); }
      else if (ev.key === 'Tab') trapTab(ev, top.el);
      return;
    }
    if (drawerState) {
      if (ev.key === 'Escape') { ev.preventDefault(); closeDrawer(); }
      else if (ev.key === 'Tab') trapTab(ev, drawerState.panel);
    }
  });

  /* ===================== Store ===================== */
  const S = {
    state: null,
    page: 'projects',
    mountedPage: null,
    filter: 'all',
    search: '',
    deferred: false,
    connected: true,
    pending: {},     // projectId -> 'starting' | 'stopping'
    pathsOpen: {},   // projectId -> true while the card shows its PHP / Composer / DB paths
    dbPending: {},   // serverId -> 'starting' | 'stopping'
    dbOpen: {},      // serverId -> {loading, items, error}
    dbForce: {},     // serverId -> true after a graceful stop failed
    busyUpdate: {},  // projectId -> true while an update call runs
    flash: null,     // projectId to highlight once
    warnOpen: {},    // 'p:<projectId>' | 'd:<serverId>' -> true while that card's warning list is expanded
    setup: {},       // projectId -> {sig, loading, data} from GET /api/projects/:id/setup (fetched lazily, not every poll)
    setupJobs: {},   // projectId -> jobId while a "Sab khud set karein" job runs
    lastServerTheme: undefined,
    lastServerLang: undefined,
    ready: false
  };
  // Page labels/subtitles are looked up at render time (t('page.<id>'), t('page.<id>.sub')).
  const PAGES = [
    {id: 'projects', icon: 'grid'},
    {id: 'inbox', icon: 'inbox'},
    {id: 'db', icon: 'db'},
    {id: 'move', icon: 'move'},
    {id: 'runtimes', icon: 'cpu'},
    {id: 'setup', icon: 'download'},
    {id: 'settings', icon: 'sliders'}
  ];
  function pageLabel(id) { return t('page.' + id); }
  function pageSub(id) { return t('page.' + id + '.sub'); }
  const pageImpl = {};
  function arr(v) { return Array.isArray(v) ? v : []; }

  function normalizeState(r) {
    const st = Object.assign({}, r);
    st.panel = st.panel || {};
    st.settings = st.settings || {};
    const rt = st.runtimes || {};
    st.runtimes = {scannedAt: rt.scannedAt || null, scanning: !!rt.scanning, php: arr(rt.php), composer: arr(rt.composer), db: arr(rt.db)};
    st.projects = arr(st.projects);
    st.dbServers = arr(st.dbServers);
    const ex = st.external || {};
    st.external = {php: arr(ex.php), db: arr(ex.db)};
    st.jobs = arr(st.jobs);
    return st;
  }
  function findProject(id) { return S.state ? S.state.projects.find((p) => p.id === id) || null : null; }
  function findServer(id) { return S.state ? S.state.dbServers.find((d) => d.id === id) || null : null; }
  function okPhp() { return S.state ? S.state.runtimes.php.filter((r) => r && r.ok) : []; }
  function okComposer() { return S.state ? S.state.runtimes.composer.filter((r) => r && r.ok) : []; }
  function dbKindLabel(kind) {
    const k = String(kind || '').toLowerCase();
    return k === 'mysql' ? 'MySQL' : k === 'mariadb' ? 'MariaDB' : (kind || 'DB');
  }
  function serverTitle(d) { return dbKindLabel(d.kind) + (d.version ? ' ' + d.version : ''); }
  function serverName(d) { return d ? (d.label || serverTitle(d)) : ''; }

  /* ===================== Polling ===================== */
  const POLL_VISIBLE = 3000;
  const POLL_HIDDEN = 10000;
  let pollTimer = null;
  let inflight = null;
  let pollingStopped = false;

  function stopPolling() { pollingStopped = true; clearTimeout(pollTimer); }
  function schedulePoll(delay) {
    if (pollingStopped) return;
    clearTimeout(pollTimer);
    const wait = delay != null ? delay : (document.hidden ? POLL_HIDDEN : POLL_VISIBLE);
    pollTimer = setTimeout(async () => { await refresh(); schedulePoll(); }, wait);
  }
  /** Fetch /api/state and re-render. Never rejects. */
  function refresh(opts) {
    if (inflight) return inflight;
    const manual = !!(opts && opts.manual);
    inflight = (async () => {
      const r = await api('GET', '/api/state');
      if (r && r.ok !== false && Array.isArray(r.projects)) {
        S.state = normalizeState(r);
        hideBanner('state');
        setConnected(true);
        try {
          syncServerTheme();
          syncServerLang();
          renderAll();
        } catch (e) {
          recordError(e && e.stack ? e.stack : String(e));
        }
        return true;
      }
      if (r.code === 'NETWORK') setConnected(false);
      else if (r.code !== 'BAD_TOKEN') {
        if (manual) toast('error', t('state.loadFail'), errorText(r));
        if (!S.state) showBanner('state', 'bad', t('state.loadFailBanner', {err: errorText(r)}), {label: t('common.retry'), icon: 'refresh', onClick: () => refresh({manual: true})});
      }
      return false;
    })().then((v) => { inflight = null; return v; }, (e) => { inflight = null; recordError(e && e.stack ? e.stack : String(e)); return false; });
    return inflight;
  }
  /** Refresh soon (used right after mutations). */
  function refreshSoon() { schedulePoll(250); }

  function setConnected(ok) {
    if (S.connected === ok) return;
    S.connected = ok;
    if (ok) {
      hideBanner('offline');
      toast('success', t('conn.back'));
    } else {
      showBanner('offline', 'bad', t('conn.lost'),
        {label: t('conn.retryNow'), icon: 'refresh', onClick: () => refresh({manual: true})});
    }
    updateFooter();
  }
  document.addEventListener('visibilitychange', () => {
    if (pollingStopped) return;
    if (!document.hidden) schedulePoll(0); else schedulePoll();
  });

  /* ===================== Theme control ===================== */
  const THEME_ICON = {black: 'moon', silver: 'sun', auto: 'monitor'};
  function themeLabel(name) { return t('theme.' + name + 'Long'); }
  function syncServerTheme() {
    const th = normTheme(S.state.settings.theme);
    if (S.lastServerTheme === th) return;
    S.lastServerTheme = th;
    if (themePref !== th) { themePref = th; lsSet(THEME_KEY, th); applyTheme(); }
    updateThemeButton();
  }
  async function setThemePref(next) {
    themePref = normTheme(next);
    lsSet(THEME_KEY, themePref);
    applyTheme();
    updateThemeButton();
    S.lastServerTheme = themePref;
    const r = await api('POST', '/api/settings', {theme: themePref});
    if (!r.ok) toast('warn', t('theme.saveFail'), errorText(r));
  }
  function updateThemeButton() {
    const b = byId('theme-btn');
    if (b) {
      const label = t('theme.btn', {name: themeLabel(themePref)});
      b.replaceChildren(icon(THEME_ICON[themePref] || 'moon'));
      b.title = label;
      b.setAttribute('aria-label', label);
    }
    for (const el of document.querySelectorAll('[data-theme-choice]')) {
      el.setAttribute('aria-pressed', String(el.dataset.themeChoice === themePref));
    }
  }

  /* ===================== Language control ===================== */
  /** The server's settings.lang wins over localStorage (like the theme). Missing (older backend) = ignored. */
  function syncServerLang() {
    const raw = S.state.settings.lang;
    if (raw == null) return;
    const l = normLang(raw);
    if (S.lastServerLang === l) return;
    S.lastServerLang = l;
    if (l !== lang) setLangLocal(l);
  }
  function setLangLocal(l) {
    lang = normLang(l);
    lsSet(LANG_KEY, lang);
    applyLang();
    rerenderEverything();
  }
  async function setLangPref(l) {
    const next = normLang(l);
    if (next === lang) return;
    setLangLocal(next);
    S.lastServerLang = lang;
    const r = await api('POST', '/api/settings', {lang});
    if (!r.ok) toast('warn', t('lang.saveFail'), errorText(r));
    // Texts that come from the backend (warnings, errors, job logs) switch on the next state.
    await refreshNow();
  }
  /** Rebuild the chrome and the current page in the new language (keeps unsaved Settings edits). */
  function rerenderEverything() {
    closeMenu();
    const cur = S.mountedPage && pageImpl[S.mountedPage];
    const snap = cur && cur.snapshot ? cur.snapshot() : null;
    buildChrome();
    if (cur && cur.unmount) cur.unmount();
    S.mountedPage = null;
    showPage(S.page);
    if (snap && S.mountedPage && pageImpl[S.mountedPage].restore) pageImpl[S.mountedPage].restore(snap);
    if (S.state) renderAll();
  }
  function langMenuItems() {
    return LANGS.map((l) => ({
      label: LANG_NATIVE[l], checked: l === lang, lang: l === 'ur' ? 'ur' : 'en', dir: l === 'ur' ? 'rtl' : 'ltr',
      onClick: () => setLangPref(l)
    }));
  }
  function updateLangControls() {
    const b = byId('lang-btn');
    if (b) {
      const label = t('lang.btn', {name: LANG_NATIVE[lang]});
      b.title = label;
      b.setAttribute('aria-label', label);
      const code = b.querySelector('.lang-code');
      if (code) code.textContent = LANG_SHORT[lang];
    }
    for (const el of document.querySelectorAll('[data-lang-choice]')) {
      el.setAttribute('aria-pressed', String(el.dataset.langChoice === lang));
    }
  }

  /* ===================== Chrome: sidebar + topbar ===================== */
  function buildChrome() {
    const nav = h('nav', {class: 'nav', 'aria-label': t('nav.aria')});
    for (const p of PAGES) {
      nav.appendChild(h('a', {class: 'nav-item', href: '#/' + p.id, dataset: {page: p.id}},
        icon(p.icon), h('span', null, pageLabel(p.id)), h('span', {class: 'nav-count', id: 'nav-count-' + p.id})));
    }
    byId('sidebar').replaceChildren(
      h('a', {class: 'brand', href: '#/projects', 'aria-label': 'PHP Station — ' + pageLabel('projects')},
        brandMark(),
        h('span', {class: 'brand-text', dir: 'ltr'},
          h('span', {class: 'brand-name'}, 'PHP ', h('b', null, 'Station')),
          h('span', {class: 'brand-sub'}, 'PHP · Composer · MariaDB'))),
      nav,
      h('div', {class: 'sidebar-foot', id: 'sidebar-foot'}));
    const refreshBtn = btn(t('top.refresh'), {kind: 'ghost', iconOnly: true, icon: 'refresh', attrs: {id: 'refresh-btn'}});
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.classList.add('is-spinning');
      await refresh({manual: true});
      setTimeout(() => refreshBtn.classList.remove('is-spinning'), 300);
    });
    // Compact language switcher: icon + short code; opens a 3-way radio menu.
    const langBtn = h('button', {type: 'button', class: 'btn btn-ghost lang-btn', id: 'lang-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false'},
      icon('translate'), h('span', {class: 'lang-code'}, LANG_SHORT[lang]));
    langBtn.addEventListener('click', () => openMenu(langBtn, langMenuItems(), {label: t('lang.menu')}));
    const themeBtn = btn(t('top.theme'), {kind: 'ghost', iconOnly: true, icon: THEME_ICON[themePref] || 'moon', attrs: {id: 'theme-btn'}});
    themeBtn.addEventListener('click', () => {
      setThemePref(THEMES[(THEMES.indexOf(themePref) + 1) % THEMES.length]);
    });
    byId('topbar').replaceChildren(
      h('div', {class: 'page-heading'}, h('h1', {class: 'page-title', id: 'page-title'}, ''), h('p', {class: 'page-sub', id: 'page-sub'}, '')),
      h('div', {class: 'live-chips', id: 'live-chips'}),
      h('div', {class: 'topbar-actions'}, refreshBtn, langBtn, themeBtn));
    updateThemeButton();
    updateLangControls();
    updateFooter();
    const skip = byId('skip-link');
    if (skip) {
      skip.textContent = t('skip');
      if (!skip.__dpBound) {
        skip.__dpBound = true;
        skip.addEventListener('click', (ev) => { ev.preventDefault(); byId('main').focus(); });
      }
    }
  }

  function updateFooter() {
    const foot = byId('sidebar-foot');
    if (!foot) return;
    const panel = S.state ? S.state.panel : {};
    const rt = S.state ? S.state.runtimes : null;
    foot.replaceChildren(
      h('div', {class: 'foot-row'}, h('span', {class: ['conn-dot', !S.connected && 'is-off'], 'aria-hidden': 'true'}),
        h('span', null, S.connected ? t('foot.running') : t('foot.offline'))),
      h('div', {class: 'foot-row'}, h('span', null, t('common.port')), h('span', {class: 'mono'}, panel.port ? ':' + panel.port : '-'),
        h('span', null, '·'), h('span', {class: 'mono'}, panel.version ? 'v' + panel.version : '')),
      rt && rt.scannedAt ? h('div', {class: 'foot-row', dataset: {since: rt.scannedAt, mode: 'ago', tpl: 'foot.scan'}}, t('foot.scan', {d: agoText(rt.scannedAt)})) : null,
      h('a', {class: 'foot-credit', href: X8CODE_URL, target: '_blank', rel: 'noopener noreferrer', title: t('about.siteTitle')}, t('foot.credit')));
  }

  function updateChrome() {
    const st = S.state;
    const runningProjects = st.projects.filter((p) => p.status === 'running').length;
    const runningDb = st.dbServers.filter((d) => d.status === 'running').length;
    const pc = byId('nav-count-projects');
    if (pc) { pc.textContent = runningProjects ? String(runningProjects) : ''; pc.title = tn('nav.projRunning', runningProjects); }
    const dc = byId('nav-count-db');
    if (dc) { dc.textContent = runningDb ? String(runningDb) : ''; dc.title = tn('nav.dbRunning', runningDb); }
    const ib = st.inbox || {};
    const ibNew = ((ib.mail && ib.mail.unread) || 0) + ((ib.dumps && ib.dumps.unread) || 0) + (ib.errors || 0);
    const ic = byId('nav-count-inbox');
    if (ic) { ic.textContent = ibNew ? String(ibNew > 99 ? '99+' : ibNew) : ''; ic.title = t('nav.inboxNew', {n: ibNew}); ic.classList.toggle('is-hot', ibNew > 0); }
    try { inboxNotify(st); } catch (e) { recordError(e && e.stack ? e.stack : String(e)); }

    const chips = byId('live-chips');
    const runningJobs = st.jobs.filter((j) => j.status === 'running');
    const chipSig = [lang, runningProjects, runningDb, st.runtimes.scanning, st.jobs.length, runningJobs.length].join('|');
    if (chips && chips.__dpSig !== chipSig && !(menuState && chips.contains(menuState.anchor))) {
      chips.__dpSig = chipSig;
      const list = [
        chip(runningProjects ? tn('live.proj', runningProjects) : t('live.projNone'),
          {cls: 'live-chip', dot: runningProjects ? 'dot-ok pulse' : 'dot', title: t('live.projTitle'), onClick: () => goPage('projects')}),
        chip(runningDb ? tn('live.db', runningDb) : t('live.dbNone'),
          {cls: 'live-chip', dot: runningDb ? 'dot-ok pulse' : 'dot', title: t('live.dbTitle'), onClick: () => goPage('db')})
      ];
      if (st.runtimes.scanning) list.push(chip(t('live.scanning'), {cls: 'live-chip', dot: 'dot-busy pulse', onClick: () => goPage('runtimes')}));
      if (st.jobs.length) {
        const jc = chip(runningJobs.length ? tn('live.jobs', runningJobs.length) : t('live.jobsRecent'),
          {cls: 'live-chip', icon: 'bolt', dot: runningJobs.length ? 'dot-busy pulse' : null});
        jc.setAttribute('aria-haspopup', 'menu');
        jc.setAttribute('aria-expanded', 'false');
        jc.addEventListener('click', () => openMenu(jc, jobsMenuItems(), {label: t('live.jobsRecent')}));
        list.push(jc);
      }
      chips.replaceChildren(...list);
    }
    updateFooter();
  }
  function jobsMenuItems() {
    const items = [{heading: t('jobs.heading')}];
    for (const j of S.state.jobs.slice(0, 10)) {
      items.push({
        label: bidi(j.title || j.type || j.id),
        icon: j.status === 'running' ? 'clock' : j.status === 'failed' ? 'alert-circle' : 'check-circle',
        hint: j.status === 'running' ? t('jobs.running') : clockTime(j.endedAt || j.startedAt),
        onClick: () => showJob(j.id, {title: bidi(j.title) || t('jobs.job'), fromHistory: true})
      });
    }
    return items;
  }

  /* ===================== Routing & rendering ===================== */
  function pageFromHash() {
    const m = /^#\/([a-z]+)/.exec(window.location.hash || '');
    const id = m ? m[1] : null;
    return PAGES.some((p) => p.id === id) ? id : null;
  }
  function goPage(id) {
    if (window.location.hash !== '#/' + id) window.location.hash = '#/' + id;
    else showPage(id);
  }
  window.addEventListener('hashchange', () => { const id = pageFromHash(); if (id) showPage(id); });

  function showPage(id) {
    closeMenu();
    S.page = id;
    lsSet('devpanel.page', id);
    for (const a of document.querySelectorAll('.nav-item')) {
      if (a.dataset.page === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    const label = pageLabel(id);
    const sub = pageSub(id);
    const titleEl = byId('page-title');
    if (titleEl) titleEl.textContent = label;
    const s = byId('page-sub');
    if (s) { s.textContent = sub; s.title = sub; }
    document.title = label + ' · PHP Station';
    renderPage();
  }
  function renderPage() {
    const main = byId('main');
    if (!main) return;
    if (!S.state) {
      if (!main.querySelector('.sk-card')) main.replaceChildren(skeleton());
      S.mountedPage = null;
      return;
    }
    if (S.mountedPage !== S.page) {
      const prev = S.mountedPage && pageImpl[S.mountedPage];
      if (prev && prev.unmount) prev.unmount();
      main.replaceChildren();
      pageImpl[S.page].mount(main);
      S.mountedPage = S.page;
    }
    pageImpl[S.page].update(S.state);
  }
  function renderAll() {
    if (!S.state) return;
    S.deferred = false;
    updateChrome();
    renderPage();
    tickTimes();
    if (!S.ready) {
      S.ready = true;
      document.body.dataset.ready = '1';
    }
  }
  function flushDeferred() {
    if (!S.deferred || !S.state) return;
    try { renderAll(); } catch (e) { recordError(e && e.stack ? e.stack : String(e)); }
  }
  document.addEventListener('focusout', () => { if (S.deferred) setTimeout(flushDeferred, 0); });

  /** Update every "... se" / "... pehle" text without re-rendering (data-tpl = i18n key with {d}). */
  function tickTimes() {
    for (const el of document.querySelectorAll('[data-since]')) {
      const txt = el.dataset.mode === 'ago' ? agoText(el.dataset.since) : sinceText(el.dataset.since);
      const full = el.dataset.tpl ? t(el.dataset.tpl, {d: txt}) : txt;
      if (el.textContent !== full) el.textContent = full;
    }
  }
  setInterval(tickTimes, 20000);

  /** Is the user interacting inside this element (focused field or open menu)? */
  function isLocked(el) {
    if (menuState && el.contains(menuState.anchor)) return true;
    const a = document.activeElement;
    if (!a || a === document.body || !el.contains(a)) return false;
    return a.tagName === 'SELECT' || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA';
  }
  /**
   * Keyed list rendering: unchanged items keep their DOM node; changed items are rebuilt unless the user is
   * editing inside them (then S.deferred is set and they are rebuilt after focus leaves).
   */
  function reconcile(container, items, keyOf, sigOf, build) {
    const existing = new Map();
    for (const child of Array.from(container.children)) {
      if (child.dataset && child.dataset.key != null) existing.set(child.dataset.key, child);
      else child.remove();
    }
    const active = document.activeElement;
    const seen = new Set();
    let prev = null;
    for (const item of items) {
      const key = String(keyOf(item));
      const sig = sigOf(item);
      let el = existing.get(key);
      if (el && el.__dpSig !== sig) {
        if (isLocked(el)) {
          S.deferred = true;
        } else {
          const fresh = build(item);
          fresh.dataset.key = key;
          fresh.__dpSig = sig;
          const fk = active && el.contains(active) && active.dataset ? active.dataset.fk : null;
          container.replaceChild(fresh, el);
          if (fk) {
            const target = fresh.querySelector('[data-fk="' + cssEsc(fk) + '"]');
            if (target && !target.disabled) target.focus({preventScroll: true});
          }
          el = fresh;
        }
      } else if (!el) {
        el = build(item);
        el.dataset.key = key;
        el.__dpSig = sig;
      }
      seen.add(key);
      const want = prev ? prev.nextSibling : container.firstChild;
      if (want !== el) container.insertBefore(el, want);
      prev = el;
    }
    for (const [key, el] of existing) if (!seen.has(key)) el.remove();
  }
  /** Replace a section's content only when its signature changed (and nobody is typing in it). */
  function patchSection(el, sig, build) {
    if (el.__dpSig === sig) return;
    if (isLocked(el)) { S.deferred = true; return; }
    el.__dpSig = sig;
    el.replaceChildren(...[].concat(build()).filter(Boolean));
  }

  function skeleton() {
    const card = () => h('div', {class: 'card sk-card', 'aria-hidden': 'true'},
      h('div', {class: 'sk-row'}, h('span', {class: 'skeleton sk-dot'}), h('span', {class: 'skeleton sk-title'}), h('span', {class: 'skeleton sk-toggle'})),
      h('span', {class: 'skeleton sk-line'}),
      h('div', {class: 'sk-row'}, h('span', {class: 'skeleton sk-pill'}), h('span', {class: 'skeleton sk-pill'}), h('span', {class: 'skeleton sk-pill'})),
      h('span', {class: 'skeleton sk-block'}),
      h('span', {class: 'skeleton sk-line short'}));
    return h('div', {role: 'status', 'aria-label': t('common.loadingAria')},
      h('div', {class: 'toolbar', 'aria-hidden': 'true'}, h('span', {class: 'skeleton sk-pill'}), h('span', {class: 'skeleton sk-pill'}), h('span', {class: 'skeleton sk-pill'})),
      h('div', {class: 'grid'}, card(), card(), card(), card()));
  }

  /** Common: show a failed API response as a toast. */
  function failToast(title, r) { toast('error', title, errorText(r)); }

  /* ===================== Shared helpers for pages ===================== */
  function verParts(v) {
    const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || ''));
    return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : [0, 0, 0];
  }
  function compareVer(a, b) {
    const x = verParts(a);
    const y = verParts(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  }
  function dirOf(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : s;
  }
  function safeUrl(u) { return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) ? u : null; }
  /** Local project / phpMyAdmin URLs open in the system's default browser (via the panel), others in a new tab. */
  function isLocalUrl(u) { return /^http:\/\/(127\.0\.0\.1|localhost):\d{4,5}(\/|$)/i.test(String(u || '')); }
  function openUrl(u) {
    const url = safeUrl(u);
    if (!url) return;
    if (!isLocalUrl(url)) { window.open(url, '_blank', 'noopener'); return; }
    api('POST', '/api/open-local', {url}).then((r) => {
      if (!r.ok) window.open(url, '_blank', 'noopener');
    });
  }
  /** kvList([[key, value, mono?], ...]) -> <dl class="kv"> */
  function kvList(pairs) {
    const dl = h('dl', {class: 'kv'});
    for (const p of pairs) {
      if (!p) continue;
      dl.appendChild(h('dt', null, p[0]));
      dl.appendChild(h('dd', {class: p[2] ? 'mono' : null}, p[1] == null || p[1] === '' ? '-' : p[1]));
    }
    return dl;
  }
  function field(label, control, cls, hint) {
    const id = control && control.id ? control.id : null;
    return h('div', {class: ['field', cls]},
      id ? h('label', {class: 'field-label', for: id}, label) : h('span', {class: 'field-label'}, label),
      control, hint ? h('div', {class: 'field-hint'}, hint) : null);
  }
  async function refreshNow() {
    if (inflight) await inflight;
    return refresh();
  }
  /** Run fn while a modal + one of its buttons show a busy state. */
  async function modalBusy(m, button, busyLabel, fn) {
    m.setBusy(true);
    for (const b of m.foot.querySelectorAll('button')) { b.dataset.wasDisabled = b.disabled ? '1' : '0'; b.disabled = true; }
    setBusy(button, true, busyLabel);
    try {
      return await fn();
    } finally {
      if (!m.closed) {
        setBusy(button, false);
        for (const b of m.foot.querySelectorAll('button')) { b.disabled = b.dataset.wasDisabled === '1'; delete b.dataset.wasDisabled; }
        m.setBusy(false);
      }
    }
  }

  /* ===================== Jobs ===================== */
  const jobWatch = new Map(); // jobId -> watcher {id, job, listeners, done, sawRunning, owned}

  function jobCode(job) {
    if (!job) return null;
    return (job.result && typeof job.result === 'object' && job.result.code) || job.code || null;
  }
  function jobErrorText(job) {
    if (!job) return t('job.unknown');
    if (typeof job.error === 'string' && job.error.trim()) return bidi(job.error);
    if (job.result && typeof job.result === 'object' && job.result.error) return bidi(String(job.result.error));
    const bad = arr(job.steps).filter((s) => s && s.level === 'bad').pop();
    return bad ? bidi(String(bad.text)) : t('job.seeLog');
  }

  /** Poll /api/jobs/:id every 700 ms until the job is no longer running. */
  function watchJob(id) {
    const existing = jobWatch.get(id);
    if (existing) return existing;
    const w = {id, job: null, listeners: new Set(), sawRunning: false, owned: false, misses: 0};
    w.done = new Promise((resolve) => { w.resolve = resolve; });
    jobWatch.set(id, w);
    const finish = (job) => {
      w.job = job;
      jobWatch.delete(id);
      for (const fn of Array.from(w.listeners)) { try { fn(job); } catch (e) { recordError(e && e.stack ? e.stack : String(e)); } }
      w.resolve(job);
      refreshSoon();
    };
    const tick = async () => {
      const r = await api('GET', '/api/jobs/' + enc(id));
      if (r.ok && r.job && typeof r.job === 'object') {
        w.misses = 0;
        const job = r.job;
        job.steps = arr(job.steps);
        if (job.status === 'running') {
          w.sawRunning = true;
          w.job = job;
          for (const fn of Array.from(w.listeners)) { try { fn(job); } catch (e) { recordError(e && e.stack ? e.stack : String(e)); } }
        } else {
          finish(job);
          return;
        }
      } else if (r.code === 'BAD_TOKEN') {
        finish({id, status: 'failed', steps: [], error: errorText(r)});
        return;
      } else {
        w.misses += 1;
        const limit = r.code === 'NETWORK' ? 120 : 6;
        if (w.misses >= limit) {
          finish(Object.assign({}, w.job || {id, steps: []}, {status: 'failed', error: errorText(r, t('job.noStatus'))}));
          return;
        }
      }
      setTimeout(tick, 700);
    };
    tick();
    return w;
  }

  const STEP_ICON = {ok: 'check-circle', warn: 'alert', bad: 'alert-circle', info: 'dot'};
  function stepItem(s) {
    const lvl = STEP_ICON[s && s.level] ? s.level : 'info';
    const sr = lvl === 'info' ? '' : t('step.' + lvl);
    return h('li', {class: ['step', 'step-' + lvl]},
      icon(STEP_ICON[lvl]),
      h('div', {class: 'step-text'}, sr ? h('span', {class: 'sr-only'}, sr) : null, bidi(String(s && s.text != null ? s.text : ''))),
      h('span', {class: 'step-time'}, clockTime(s && s.at)));
  }
  /** Append only new steps (keeps scroll position, no flicker). */
  function syncSteps(list, steps) {
    if (list.__dpCount == null || steps.length < list.__dpCount) { list.replaceChildren(); list.__dpCount = 0; }
    if (steps.length === list.__dpCount) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    for (let i = list.__dpCount; i < steps.length; i++) list.appendChild(stepItem(steps[i]));
    list.__dpCount = steps.length;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }
  function statusChip(job) {
    if (!job || job.status === 'running') return chip(t('job.running'), {kind: 'accent', dot: 'dot-busy pulse', lg: true});
    if (job.status === 'done') return chip(t('job.done'), {kind: 'ok', icon: 'check', lg: true});
    return chip(t('job.failed'), {kind: 'bad', icon: 'x', lg: true});
  }
  function formatLintError(e) {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
      const where = [e.file, e.line ? 'line ' + e.line : null].filter(Boolean).join(' : ');
      const msg = e.message || e.error || e.text || '';
      return where + (where && msg ? ' — ' : '') + msg;
    }
    return String(e);
  }
  function nextList(items) {
    if (!items.length) return null;
    return h('div', {class: 'next-box'}, h('h4', null, icon('arrow'), t('job.next')),
      h('ol', {class: 'next-list'}, items.map((x) => h('li', null, typeof x === 'string' ? x : (x && (x.text || x.title)) || JSON.stringify(x)))));
  }
  /** Generic result view for check / lint / clear-cache / scans. */
  function genericResult(job) {
    const out = [];
    const res = job.result && typeof job.result === 'object' ? job.result : null;
    if (!res) return out;
    if (Array.isArray(res.errors) || typeof res.count === 'number') {
      const errs = arr(res.errors);
      out.push(h('div', {class: 'result-summary'},
        typeof res.count === 'number' ? chip(tn('lint.filesChecked', res.count, {n: fmtInt(res.count)}), {kind: 'info', lg: true, icon: 'code'}) : null,
        chip(errs.length ? tn('lint.errors', errs.length) : t('lint.noErrors'), {kind: errs.length ? 'bad' : 'ok', lg: true, icon: errs.length ? 'alert-circle' : 'check'})));
      if (errs.length) out.push(h('pre', {class: 'term-mini', dir: 'ltr'}, errs.slice(0, 300).map(formatLintError).join('\n')));
    }
    if (typeof res.output === 'string' && res.output.trim()) out.push(h('pre', {class: 'term-mini', dir: 'ltr'}, res.output));
    const tail = Array.isArray(res.logTail) ? res.logTail.join('\n') : res.logTail;
    if (typeof tail === 'string' && tail.trim()) out.push(h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('log.tail')), h('pre', {class: 'term-mini', dir: 'ltr'}, tail)));
    const next = res.next || res.nextSteps || res.aglaKaam || res.todo;
    if (Array.isArray(next)) { const nl = nextList(next); if (nl) out.push(nl); }
    return out;
  }

  /**
   * Determinate progress of a running job, when the backend reports one:
   * job.progress {percent|pct} or {bytes|downloaded|received, total|totalBytes}; with fromSteps also a
   * "… 45% …" in the newest log line (the installer logs its download progress every 2 s).
   * Returns {pct|null, text} or null.
   */
  // Stages whose bytes/percent describe real progress; other stages (extract, scan, …) show a moving bar + their name.
  const PCT_STAGES = new Set(['download', 'import']);
  function jobProgress(job, fromSteps) {
    if (!job || job.status !== 'running') return null;
    const pr = job.progress && typeof job.progress === 'object' ? job.progress : {};
    const num = (v) => (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null);
    const stage = typeof pr.stage === 'string' ? pr.stage : null;
    const label = stage && hasT('jstage.' + stage) ? t('jstage.' + stage) : null;
    let pct = null;
    let text = '';
    if (!stage || PCT_STAGES.has(stage)) {
      pct = num(pr.percent != null ? pr.percent : pr.pct);
      const done = num(pr.bytes != null ? pr.bytes : pr.downloaded != null ? pr.downloaded : pr.received);
      const total = num(pr.total != null ? pr.total : pr.totalBytes);
      if (pct == null && done != null && total) pct = (done / total) * 100;
      if (done != null) text = fmtBytes(done) + (total ? ' / ' + fmtBytes(total) : '');
      if (pct == null && fromSteps) {
        const steps = arr(job.steps);
        const last = steps.length ? String((steps[steps.length - 1] && steps[steps.length - 1].text) || '') : '';
        const m = /(\d{1,3}(?:[.,]\d+)?)\s?%/.exec(last);
        if (m) pct = Number(m[1].replace(',', '.'));
      }
    }
    if (pr.dumpBytes != null) text = t('mv.dumpSize') + ' ' + fmtBytes(pr.dumpBytes);
    if (pct == null && !text && !label) return null;
    return {pct: pct == null ? null : Math.max(0, Math.min(100, pct)), label, text};
  }

  /** Builds the live view of one job (used inside the job modal). opts.progress(job) -> {pct, text} | null. */
  function jobView(opts) {
    const chipSlot = h('span');
    const timeSlot = h('span', {class: 'muted small'});
    const pctSlot = h('span', {class: 'job-pct', hidden: true});
    const bar = h('div', {class: 'progress-bar is-indeterminate', role: 'progressbar', 'aria-label': t('job.progress'), 'aria-busy': 'true'});
    const list = h('ol', {class: 'steps', dataset: {empty: t('job.starting')}, 'aria-live': 'polite', 'aria-label': t('job.logAria')});
    const resultArea = h('div', {class: 'stack'});
    const root = h('div', {class: 'stack'}, h('div', {class: 'job-status'}, chipSlot, timeSlot, pctSlot), bar, list, resultArea);
    let lastStatus = null;
    function showProgress(job) {
      const pg = job.status === 'running' && opts && opts.progress ? opts.progress(job) : null;
      const det = !!(pg && pg.pct != null);
      if (job.status === 'running') {
        bar.className = 'progress-bar ' + (det ? 'is-determinate' : 'is-indeterminate');
        if (det) {
          bar.style.setProperty('--pct', pg.pct.toFixed(1) + '%');
          bar.setAttribute('aria-valuemin', '0');
          bar.setAttribute('aria-valuemax', '100');
          bar.setAttribute('aria-valuenow', String(Math.round(pg.pct)));
        } else {
          bar.removeAttribute('aria-valuenow');
        }
      }
      const extra = pg && pg.text ? (HAS_ARABIC.test(pg.text) ? bidi(pg.text) : iso(pg.text)) : null;
      const txt = pg ? [pg.label || null, det ? iso(Math.floor(pg.pct) + '%') : null, extra].filter(Boolean).join(' · ') : '';
      pctSlot.hidden = !txt;
      if (pctSlot.textContent !== txt) pctSlot.textContent = txt;
    }
    function update(job) {
      if (!job) return;
      if (job.status !== lastStatus) {
        lastStatus = job.status;
        chipSlot.replaceChildren(statusChip(job));
        const running = job.status === 'running';
        bar.className = 'progress-bar ' + (running ? 'is-indeterminate' : job.status === 'done' ? 'is-done' : 'is-failed');
        bar.setAttribute('aria-busy', String(running));
        if (!running) {
          const parts = [];
          if (job.status === 'failed') parts.push(callout('bad', t('job.notDone'), jobErrorText(job)));
          const custom = opts && opts.renderResult ? opts.renderResult(job) : null;
          if (custom) parts.push(custom); else parts.push(...genericResult(job));
          resultArea.replaceChildren(...parts.filter(Boolean));
        }
      }
      if (job.startedAt) {
        const end = job.endedAt ? parseTime(job.endedAt) : Date.now();
        const secs = Math.max(0, Math.round((end - parseTime(job.startedAt)) / 1000));
        timeSlot.textContent = isFinite(secs) ? (secs < 60 ? t('time.secs', {n: secs}) : durationText(secs * 1000)) : '';
      }
      showProgress(job);
      syncSteps(list, arr(job.steps));
    }
    return {root, update};
  }

  /**
   * showJob(jobId, {title, subtitle, icon, closeOnDone, onFinal(job, modalCtrl), renderResult(job), quietCodes, modal,
   *                 progress(job) -> {pct, text}, doneMessage(job) -> text for the success toast})
   * Shows a modal with the live step log. On completion: toast (success / error); failed jobs keep their log open.
   * Returns a promise for the final job.
   */
  function showJob(id, opts) {
    const o = opts || {};
    const w = watchJob(id);
    let ctrl = null;
    let view = null;
    const listener = (job) => { if (view) view.update(job); };
    const openView = () => {
      view = jobView(o);
      ctrl = openModal({
        title: o.title || (w.job && bidi(w.job.title)) || t('jobs.job'), subtitle: o.subtitle, icon: o.icon || 'bolt', size: 'lg', body: view.root,
        actions: [{label: t('common.close'), value: null, autofocus: true}],
        onClose: () => { ctrl = null; view = null; w.listeners.delete(listener); }
      });
      if (w.job) view.update(w.job);
      w.listeners.add(listener);
    };
    if (o.modal !== false) openView();
    if (!w.owned && !o.fromHistory) {
      w.owned = true;
      w.done.then(async (job) => {
        const title = o.title || bidi(job.title) || t('jobs.job');
        const code = jobCode(job);
        const quiet = arr(o.quietCodes).includes(code);
        if (job.status === 'done' && !quiet) {
          let msg = null;
          try { msg = o.doneMessage ? o.doneMessage(job) : null; } catch (e) { msg = null; }
          toast('success', t('job.toastDone', {title}), msg);
          if (ctrl && o.closeOnDone) { const c = ctrl; setTimeout(() => c.close(), 900); }
        } else if (job.status !== 'done' && !quiet) {
          toast('error', t('job.toastFail', {title}), jobErrorText(job), {
            duration: 9000,
            actions: ctrl ? [] : [{label: t('job.viewLog'), onClick: () => reopenJob(job, o)}]
          });
        }
        if (o.onFinal) {
          try { await o.onFinal(job, ctrl); } catch (e) { recordError(e && e.stack ? e.stack : String(e)); }
        }
      });
    }
    return w.done;
  }
  /** Re-open a finished job's log in a modal. */
  function reopenJob(job, o) {
    const view = jobView(o || {});
    openModal({title: (o && o.title) || bidi(job.title) || t('jobs.job'), icon: (o && o.icon) || 'bolt', size: 'lg', body: view.root,
      actions: [{label: t('common.close'), value: null, autofocus: true}]});
    view.update(job);
  }

  /* ===================== Projects page ===================== */
  // Short warning titles per code (project: warn.<CODE>, DB server: warndb.<CODE>); unknown codes show the code.
  function warnTitle(w, prefix) {
    const key = prefix + '.' + (w && w.code);
    return w && w.code && hasT(key) ? t(key) : ((w && w.code) || t('warn.generic'));
  }
  function routerLabel(r) { return r && hasT('router.' + r) ? t('router.' + r) : (r || '-'); }
  function jobTitle(kind) { return t('jobt.' + kind); }
  const JOB_ICONS = {check: 'shield', lint: 'code', 'clear-cache': 'eraser'};
  const TERMINAL_ACTIONS = [
    {action: 'shell', labelKey: 'term.open', icon: 'terminal'},
    {action: 'composer-install', label: 'composer install', icon: 'download', needsComposer: true},
    {action: 'composer-update-dry', label: 'composer update --dry-run', icon: 'eye', needsComposer: true},
    {action: 'check-platform', label: 'check-platform-reqs', icon: 'shield', needsComposer: true},
    {action: 'migrate-status', label: 'migrate:status', icon: 'db', needsLaravel: true},
    {action: 'optimize-clear', label: 'optimize:clear', icon: 'eraser', needsLaravel: true},
    {action: 'tinker', label: 'tinker', icon: 'code', needsLaravel: true}
  ];
  const P = {};
  pageImpl.projects = {mount: mountProjects, update: updateProjects};

  function isOn(p) { return p.status === 'running' || p.status === 'starting'; }

  function mountProjects(root) {
    const search = h('input', {
      class: 'input', type: 'search', placeholder: t('proj.searchPh'), 'aria-label': t('proj.searchAria'),
      value: S.search, autocomplete: 'off', spellcheck: 'false'
    });
    search.addEventListener('input', debounce(() => { S.search = search.value; if (S.state) updateProjects(S.state); }, 120));
    const seg = h('div', {class: 'seg', role: 'group', 'aria-label': t('proj.filterAria')});
    P.filters = {};
    for (const f of ['all', 'running', 'stopped'].map((id) => ({id, label: t('filter.' + id)}))) {
      const count = h('span', {class: 'seg-count'});
      const b = h('button', {type: 'button', class: 'seg-btn', 'aria-pressed': String(S.filter === f.id)}, f.label, count);
      b.addEventListener('click', () => {
        S.filter = f.id;
        for (const k of Object.keys(P.filters)) P.filters[k].btn.setAttribute('aria-pressed', String(k === f.id));
        if (S.state) updateProjects(S.state);
      });
      P.filters[f.id] = {btn: b, count};
      seg.appendChild(b);
    }
    P.ext = h('div');
    P.empty = h('div');
    P.grid = h('div', {class: 'grid', id: 'project-grid', 'aria-label': pageLabel('projects')});
    root.append(
      h('div', {class: 'toolbar'},
        btn(t('proj.new'), {kind: 'primary', icon: 'plus', onClick: () => openAddProject()}),
        btn(t('clone.btn'), {icon: 'branch', title: t('clone.btnTitle'), onClick: () => openClone()}),
        btn(t('proj.scan'), {icon: 'folder-search', onClick: () => openScanProjects()}),
        btn(t('imp.btn'), {icon: 'import', title: t('imp.btnTitle'), onClick: () => openImport()}),
        btn(t('team.btn'), {icon: 'users', title: t('team.btnTitle'), onClick: () => pickTeamFolder()}),
        h('span', {class: 'spacer'}),
        h('div', {class: 'search'}, icon('search'), search),
        seg),
      P.ext, P.empty, P.grid);
  }

  function projectsGlobalSig(st) {
    return JSON.stringify([
      okPhp().map((r) => [r.path, r.version, r.dir]),
      okComposer().map((c) => [c.id, c.version, c.path]),
      st.dbServers.map((d) => [d.id, d.label, d.kind, d.version, d.port, d.status]),
      st.settings.webPortRange
    ]);
  }

  function updateProjects(st) {
    if (!P.grid) return;
    const all = st.projects;
    const on = all.filter(isOn).length;
    P.filters.all.count.textContent = String(all.length);
    P.filters.running.count.textContent = String(on);
    P.filters.stopped.count.textContent = String(all.length - on);
    renderExternal(st);
    const q = S.search.trim().toLowerCase();
    const list = all.filter((p) => {
      if (S.filter === 'running' && !isOn(p)) return false;
      if (S.filter === 'stopped' && isOn(p)) return false;
      if (q && !(String(p.name || '').toLowerCase().includes(q) || String(p.path || '').toLowerCase().includes(q))) return false;
      return true;
    });
    const emptySig = all.length === 0 ? 'none' : list.length === 0 ? 'nomatch:' + S.filter : '';
    patchSection(P.empty, emptySig, () => {
      if (emptySig === 'none') {
        return emptyState({
          icon: 'grid', title: t('proj.emptyTitle'),
          text: t('proj.emptyText'),
          actions: [btn(t('imp.btn'), {kind: 'primary', icon: 'import', onClick: () => openImport()}),
            btn(t('proj.new'), {icon: 'plus', onClick: () => openAddProject()}),
            btn(t('proj.scan'), {icon: 'folder-search', onClick: () => openScanProjects()}),
            btn(t('team.btn'), {icon: 'users', onClick: () => pickTeamFolder()})]
        });
      }
      if (emptySig) {
        return emptyState({
          small: true, icon: 'search', title: t('proj.noMatch'),
          text: S.filter === 'running' ? t('proj.noneRunning') : t('proj.changeFilter'),
          actions: [btn(t('proj.clearFilter'), {icon: 'x', onClick: () => { S.filter = 'all'; S.search = ''; S.mountedPage = null; renderAll(); }})]
        });
      }
      return null;
    });
    const gsig = projectsGlobalSig(st);
    // The "Setup" suggestions are fetched once per card and again only when something relevant changed.
    for (const p of list) ensureSetup(p, false);
    reconcile(P.grid, list, (p) => p.id,
      (p) => gsig + JSON.stringify(p) + '|' + (S.pending[p.id] || '') + (S.busyUpdate[p.id] ? 'B' : '') + (S.pathsOpen[p.id] ? 'P' : '') + '|' + setupCardSig(p.id),
      buildProjectCard);
    if (S.flash) {
      const el = P.grid.querySelector('[data-key="' + cssEsc(S.flash) + '"]');
      if (el) {
        el.scrollIntoView({block: 'center', behavior: 'smooth'});
        el.classList.remove('is-flash');
        void el.offsetWidth;
        el.classList.add('is-flash');
      }
      S.flash = null;
    }
  }

  /* ----- external php servers ----- */
  function renderExternal(st) {
    const list = st.external.php.filter((x) => x && !x.matchesProjectId);
    patchSection(P.ext, JSON.stringify(list), () => {
      if (!list.length) return null;
      return h('section', {class: 'panel ext-panel', 'aria-label': t('ext.title')},
        h('div', {class: 'panel-head'},
          h('h2', {class: 'panel-title'}, icon('alert'), t('ext.title')),
          chip(String(list.length), {kind: 'warn'}),
          h('span', {class: 'panel-sub'}, t('ext.sub'))),
        h('div', {class: 'panel-body flush'}, list.map(extRow)));
    });
  }
  function extRow(x) {
    const folder = x.projectPath ? baseName(x.projectPath) : t('ext.noFolder');
    return h('div', {class: 'ext-row'},
      h('div', {class: 'ext-port'}, ':' + x.port),
      h('div', {class: 'ext-main'},
        h('div', {class: 'ext-name', title: folder}, folder),
        h('div', {class: 'ext-path', title: x.projectPath || x.phpPath || ''}, x.projectPath || x.phpPath || '')),
      h('div', {class: 'ext-chips'},
        x.phpVersion ? chip('PHP ' + x.phpVersion, {fam: famClass(x.phpVersion)}) : chip('PHP ?', {title: x.phpPath || null}),
        chip(x.via || 'php -S', {kind: 'info', icon: 'terminal'}),
        chip('pid ' + x.pid, {mono: true})),
      h('div', {class: 'ext-actions'},
        btn(t('ext.adopt'), {
          size: 'sm', icon: 'plus', disabled: !x.projectPath, title: x.projectPath ? t('ext.adoptTitle') : t('ext.adoptNoFolder'),
          onClick: (ev) => adoptExternal(x, ev.currentTarget)
        }),
        btn(t('common.stop'), {size: 'sm', kind: 'soft-danger', icon: 'stop', onClick: (ev) => stopExternal(x, ev.currentTarget)})));
  }
  async function adoptExternal(x, b) {
    setBusy(b, true, t('ext.adopting'));
    const r = await api('POST', '/api/external/adopt', {pid: x.pid});
    setBusy(b, false);
    if (!r.ok) return failToast(t('ext.adoptFail'), r);
    toast('success', t('ext.adopted'), r.project ? r.project.name + ' · :' + x.port : baseName(x.projectPath));
    if (r.project) S.flash = r.project.id;
    await refreshNow();
  }
  async function stopExternal(x, b) {
    const yes = await confirmDialog({
      title: t('ext.stopQ'), message: t('ext.stopMsg'), danger: true, icon: 'alert',
      details: kvList([[t('common.port'), ':' + x.port, true], [t('common.folder'), x.projectPath || '-', true], [t('ext.via'), x.via || 'php -S'],
        ['pid', x.topPid && x.topPid !== x.pid ? t('ext.pidChain', {pid: x.pid, top: x.topPid}) : String(x.pid)]]),
      confirmLabel: t('common.yesStop')
    });
    if (!yes) return;
    setBusy(b, true);
    const r = await api('POST', '/api/external/stop', {pid: x.pid});
    setBusy(b, false);
    if (!r.ok) return failToast(t('ext.stopFail'), r);
    toast('success', t('ext.stopped'), ':' + x.port);
    await refreshNow();
  }

  /* ----- selects ----- */
  function bestSuggestion(sugg) {
    const list = arr(sugg);
    return list.find((s) => s && s.satisfies === true && !s.hint) || list.find((s) => s && s.satisfies !== false && !s.hint) || null;
  }
  function suggestionNote(s) {
    if (!s) return null;
    if (s.hint) return s.hint;
    if (s.satisfies === false) return t('sugg.notOk');
    if (s.satisfies === true) return t('sugg.ok');
    return null;
  }
  /** Short name of where a PHP comes from ("XAMPP", "Laragon D:", …); the full path is behind the card's Paths button. */
  function phpStack(path) {
    const p = String(path || '');
    if (/[\\/]runtimes[\\/]php[\\/]/i.test(p)) return 'PHP Station';
    if (/laragon/i.test(p)) return 'Laragon';
    if (/xampp/i.test(p)) return 'XAMPP';
    if (/wamp/i.test(p)) return 'WAMP';
    return 'PATH';
  }
  function phpPlace(rt) {
    const stack = phpStack(rt.path);
    const same = okPhp().filter((x) => x.version === rt.version && phpStack(x.path) === stack);
    if (same.length < 2) return stack;
    const drive = (String(rt.path).match(/^([A-Za-z]):/) || [])[1];
    const sameDrive = same.filter((x) => (String(x.path).match(/^([A-Za-z]):/) || [])[1] === drive);
    if (sameDrive.length < 2) return stack + ' ' + (drive ? drive.toUpperCase() + ':' : '');
    const top = String(rt.path).split(/[\\/]/)[1] || '';
    return stack + ' ' + (drive ? drive.toUpperCase() + ':' : '') + ' ' + top;
  }
  function phpOptionLabel(rt, s, best) {
    const star = best && normPath(best.path) === normPath(rt.path) ? ' ★' : '';
    const warn = s && (s.satisfies === false || s.hint) ? ' ⚠' : '';
    return 'PHP ' + rt.version + star + warn + ' · ' + phpPlace(rt);
  }
  /** Fill a select with all ok PHP runtimes (newest first); ★ = best suggestion, ⚠ = constraint/Laravel warning. */
  function fillPhpOptions(sel, sugg, selectPath) {
    sel.replaceChildren();
    const list = okPhp().slice().sort((a, b) => compareVer(b.version, a.version));
    if (!list.length) {
      sel.appendChild(h('option', {value: ''}, t('php.none')));
      sel.disabled = true;
      return;
    }
    const best = bestSuggestion(sugg);
    for (const rt of list) {
      const s = arr(sugg).find((x) => x && normPath(x.path) === normPath(rt.path)) || null;
      const note = suggestionNote(s);
      sel.appendChild(h('option', {value: rt.path, title: (note ? note + '\n' : '') + rt.path}, phpOptionLabel(rt, s, best)));
    }
    const target = selectPath || (best && best.path);
    const match = target ? list.find((rt) => normPath(rt.path) === normPath(target)) : null;
    sel.value = match ? match.path : list[0].path;
  }
  /** The full paths behind a card's PHP / Composer / DB choice (shown only after "Paths dikhayein"). */
  function projectPaths(p) {
    const phpPath = (p.php && p.php.resolvedPath) || p.phpPath || '';
    const comp = okComposer().find((c) => c.id === p.composerId) || null;
    const db = p.dbServerId && S.state ? arr(S.state.dbServers).find((d) => d.id === p.dbServerId) || null : null;
    const row = (label, value) => (value ? h('div', {class: 'pc-path-row'},
      h('span', {class: 'pc-path-label'}, label),
      h('code', {class: 'pc-path-val', title: value}, value),
      btn(t('copy.do'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'copy',
        onClick: () => copyText(value).then((ok) => toast(ok ? 'success' : 'warn', ok ? t('copy.done') : t('copy.fail'), value))})) : null);
    return h('div', {class: 'pc-paths'},
      row('PHP', phpPath),
      row('php.ini', p.php && p.php.iniFile ? p.php.iniFile : ''),
      row('Composer', comp ? comp.path : ''),
      row('DB server', db ? (db.serverExe || db.binDir || '') : ''),
      row('Datadir', db ? db.datadir || '' : ''),
      row(t('common.project'), p.path));
  }
  function phpSelect(p, disabled) {
    const sel = h('select', {
      class: 'select', id: 'p-php-' + safeId(p.id), dataset: {fk: 'php'},
      title: disabled ? t('proj.stopFirst') : t('php.choose')
    });
    const current = (p.php && p.php.resolvedPath) || p.phpPath;
    fillPhpOptions(sel, p.suggestions && p.suggestions.php, current);
    const list = okPhp();
    if (!list.some((rt) => normPath(rt.path) === normPath(current))) {
      const missing = h('option', {value: '__missing'}, t('php.missingOpt', {v: p.phpVersion || '?'}));
      missing.disabled = true;
      sel.insertBefore(missing, sel.firstChild);
      sel.value = '__missing';
    }
    sel.disabled = !!disabled || !list.length || !!S.busyUpdate[p.id];
    sel.addEventListener('change', () => {
      const rt = okPhp().find((r) => r.path === sel.value);
      if (rt) updateProject(p, {phpVersion: rt.version, phpPath: rt.path}, t('php.chosen', {v: rt.version}));
    });
    return sel;
  }
  function composerOptionLabel(c) { return 'Composer ' + c.version + ' · ' + baseName(c.path) + (c.sameAs ? ' ' + t('comp.copy') : ''); }
  function composerSelect(p, disabled) {
    const sel = h('select', {class: 'select', id: 'p-comp-' + safeId(p.id), dataset: {fk: 'composer'}, title: disabled ? t('proj.stopFirst') : t('comp.choose')});
    sel.appendChild(h('option', {value: ''}, t('common.none')));
    let found = !p.composerId;
    for (const c of okComposer().slice().sort((a, b) => compareVer(b.version, a.version))) {
      sel.appendChild(h('option', {value: c.id, title: c.path}, composerOptionLabel(c)));
      if (c.id === p.composerId) found = true;
    }
    if (!found) {
      const miss = h('option', {value: '__missing'}, t('comp.missingOpt', {v: (p.composer && p.composer.version) || ''}));
      miss.disabled = true;
      sel.appendChild(miss);
    }
    sel.value = found ? (p.composerId || '') : '__missing';
    sel.disabled = !!disabled || !!S.busyUpdate[p.id];
    sel.addEventListener('change', () => {
      const c = okComposer().find((x) => x.id === sel.value);
      updateProject(p, {composerId: sel.value || null}, c ? t('comp.chosen', {v: c.version}) : t('comp.removed'));
    });
    return sel;
  }
  function dbOptionLabel(d) { return serverName(d) + ' · :' + d.port + ' · ' + (d.status === 'running' ? t('db.optRunning') : t('db.optStopped')); }
  function dbSelect(p, disabled) {
    const sel = h('select', {class: 'select', id: 'p-db-' + safeId(p.id), dataset: {fk: 'db'}, title: disabled ? t('proj.stopFirst') : t('db.choose')});
    sel.appendChild(h('option', {value: ''}, t('db.noneEnv')));
    let found = !p.dbServerId;
    for (const d of S.state.dbServers) {
      sel.appendChild(h('option', {value: d.id}, dbOptionLabel(d)));
      if (d.id === p.dbServerId) found = true;
    }
    if (!found) {
      const miss = h('option', {value: '__missing'}, t('db.missingOpt'));
      miss.disabled = true;
      sel.appendChild(miss);
    }
    sel.value = found ? (p.dbServerId || '') : '__missing';
    sel.disabled = !!disabled || !!S.busyUpdate[p.id];
    sel.addEventListener('change', () => {
      const d = findServer(sel.value);
      updateProject(p, {dbServerId: sel.value || null}, d ? t('db.chosen', {name: serverName(d)}) : t('db.removed'));
    });
    return sel;
  }

  /* ----- warnings: one compact tag per card, expandable details ----- */
  /** Other DB server entries a SHARED_DATADIR / PORT_CLASH warning refers to (null when they can't be resolved). */
  function warnOthers(w) {
    if (!w || !Array.isArray(w.others) || !w.others.length) return null;
    const list = w.others.map((id) => findServer(id)).filter(Boolean);
    return list.length === w.others.length ? list : null;
  }
  function warnBody(w, kind, d) {
    const others = kind === 'db' ? warnOthers(w) : null;
    if (!others) return h('p', {class: 'warn-text'}, bidi(String(w.text || '')));
    const lead = w.code === 'SHARED_DATADIR' ? t('warndb.sharedLead') : t('warndb.clashLead', {port: d ? d.port : ''});
    return h('div', {class: 'warn-text'},
      h('p', null, lead),
      h('ul', {class: 'warn-servers'}, others.map((o) => h('li', null,
        h('span', {class: ['dot', o.status === 'running' ? 'dot-ok' : null], 'aria-hidden': 'true'}),
        h('span', {class: 'ws-name'}, serverTitle(o)),
        dbSubtitle(o) ? h('span', {class: 'ws-path mono', title: o.label || ''}, dbSubtitle(o)) : null,
        w.code === 'PORT_CLASH' ? null : h('span', {class: 'ws-meta mono'}, ':' + o.port),
        o.status === 'running' ? h('span', {class: 'ws-state'}, t('db.optRunning')) : null))),
      w.code === 'SHARED_DATADIR' ? h('p', {class: 'warn-note'}, t('db.oneDatadirSentence')) : null);
  }
  /**
   * Builds {tag, panel} for a card's warnings: `tag` is a small button "⚠ 2 masle" (red when any is 'bad');
   * `panel` lists every warning (bold title + full text) and is shown while the tag is expanded.
   * The open/closed state lives in S.warnOpen so it survives the 3-second re-render.
   * opts: {kind:'project'|'db', server (for db), actions(w) -> [buttons] shown under a warning}
   */
  function warnTag(key, warns, opts) {
    const list = arr(warns);
    if (!list.length) return {tag: null, panel: null};
    const o = opts || {};
    const bad = list.some((w) => w.level === 'bad');
    const open = !!S.warnOpen[key];
    const panelId = 'wd-' + safeId(key);
    const tag = h('button', {
      type: 'button', class: ['chip', 'warn-tag', bad ? 'chip-bad' : 'chip-warn'], 'aria-expanded': String(open),
      'aria-controls': panelId, title: t('warn.tagTitle'), dataset: {fk: 'warn'}
    }, icon(bad ? 'alert-circle' : 'alert'), h('span', null, tn('warn.tag', list.length)), icon('chevron-down', 'warn-chev'));
    const items = list.map((w) => {
      const lvl = w.level === 'bad' ? 'bad' : 'warn';
      const acts = o.actions ? arr(o.actions(w)).filter(Boolean) : [];
      return h('li', {class: ['warn-item', 'is-' + lvl]},
        icon(lvl === 'bad' ? 'alert-circle' : 'alert', 'warn-icon'),
        h('div', {class: 'warn-main'},
          h('strong', {class: 'warn-title'}, warnTitle(w, o.kind === 'db' ? 'warndb' : 'warn')),
          warnBody(w, o.kind, o.server),
          acts.length ? h('div', {class: 'warn-actions'}, acts) : null));
    });
    const panel = h('div', {class: 'warn-details', id: panelId, role: 'region', 'aria-label': t('warn.listAria'), hidden: !open},
      h('ul', {class: 'warn-list'}, items));
    const setOpen = (v, focusTag) => {
      if (v) S.warnOpen[key] = true; else delete S.warnOpen[key];
      tag.setAttribute('aria-expanded', String(v));
      panel.hidden = !v;
      const card = tag.closest('.card');
      if (card) card.classList.toggle('is-warn-open', v);
      if (focusTag) tag.focus({preventScroll: true});
    };
    tag.addEventListener('click', () => setOpen(tag.getAttribute('aria-expanded') !== 'true', false));
    const onKey = (ev) => {
      if (ev.key === 'Escape' && tag.getAttribute('aria-expanded') === 'true') { ev.preventDefault(); ev.stopPropagation(); setOpen(false, true); }
    };
    tag.addEventListener('keydown', onKey);
    panel.addEventListener('keydown', onKey);
    return {tag, panel, open};
  }

  /* ----- card ----- */
  function envFixButton(p, fk) {
    return btn(t('env.fixBtn', {port: p.db.port}), {size: 'sm', icon: 'pencil', fk, className: 'btn-fix', onClick: () => fixEnvPort(p)});
  }
  function buildProjectCard(p) {
    const pend = S.pending[p.id];
    const running = p.status === 'running' && pend !== 'stopping';
    const starting = p.status === 'starting' || pend === 'starting';
    const stopping = pend === 'stopping';
    const busy = starting || stopping;
    const ext = !!(p.run && p.run.external);
    const info = p.info || {};
    const locked = p.status === 'running' || starting;
    const url = safeUrl(p.url);
    const stateText = stopping ? t('status.stopping') : starting ? t('status.starting') : running ? (ext ? t('status.runningExt') : t('status.running')) : t('status.stopped');

    const head = h('div', {class: 'pc-head'},
      h('span', {class: ['dot', 'status-dot', running ? 'dot-ok pulse' : busy ? 'dot-busy pulse' : null], title: stateText, 'aria-hidden': 'true'}),
      h('div', {class: 'pc-title'},
        h('h3', {class: 'pc-name', title: p.name}, p.name),
        h('div', {class: 'pc-path'}, h('span', {class: 'mono', title: p.path}, p.path), copyButton(p.path, t('proj.copyPath')))),
      h('div', {class: 'pc-side'},
        makeSwitch({
          checked: running || starting, busy, size: 'lg', fk: 'toggle',
          label: running ? t('proj.swStop', {name: p.name}) : t('proj.swStart', {name: p.name}),
          title: running ? t('proj.swStopTitle') : t('proj.swStartTitle'),
          onToggle: (want) => (want ? startProject(p) : stopProject(p))
        }),
        h('span', {class: ['pc-state', running && 'is-on', busy && 'is-busy']}, stateText)));

    // All warnings collapse into one tag; the ".env me DB_PORT=…" fix stays reachable without expanding it.
    const mismatch = arr(p.warnings).find((w) => w.code === 'ENV_DB_PORT_MISMATCH');
    const canFixEnv = !!(mismatch && p.db && p.db.port);
    const wt = warnTag('p:' + p.id, p.warnings, {
      kind: 'project',
      actions: (w) => (w.code === 'ENV_DB_PORT_MISMATCH' && canFixEnv ? [envFixButton(p, 'envfix-in')] : null)
    });
    const badges = h('div', {class: 'badges'},
      info.isLaravel
        ? chip('Laravel ' + (info.laravel || info.laravelConstraint || '?'), {cls: 'chip-ver chip-laravel', title: info.laravelConstraint ? 'composer.json: laravel/framework ' + info.laravelConstraint : null})
        : chip(t('proj.plainPhp'), {icon: 'code'}),
      // A plain PHP project already shows "Plain PHP"; its 'none' router chip would only repeat that.
      info.router && !(info.router === 'none' && !info.isLaravel) ? chip(routerLabel(info.router), {title: 'Router: ' + info.router}) : null,
      info.composerPhp ? chip('php ' + info.composerPhp, {mono: true, title: t('proj.composerPhpTitle')}) : null,
      setupTag(p),
      p.newErrors ? chip(tn('ib.err.cardChip', p.newErrors), {kind: 'bad', icon: 'bug', title: t('ib.err.cardTitle'), onClick: () => openInbox('errors', p.id)}) : null,
      wt.tag);
    const fixBar = canFixEnv ? h('div', {class: 'pc-fix'}, envFixButton(p, 'envfix')) : null;

    const portBox = h('div', {class: 'port-box'},
      h('span', {class: 'grow'}, String(p.port || '-')),
      btn(t('port.change'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'pencil', disabled: locked, fk: 'port', title: locked ? t('proj.stopFirst') : t('port.change'), onClick: () => editProjectPort(p)}));
    const pathsOpen = !!S.pathsOpen[p.id];
    const controls = h('div', {class: 'pc-controls'},
      field('PHP', phpSelect(p, locked)),
      field('Composer', composerSelect(p, locked)),
      field(t('field.db'), dbSelect(p, locked)),
      field(t('common.port'), portBox),
      locked ? h('div', {class: 'lock-hint'}, icon('lock'), t('proj.stopFirst')) : null,
      h('div', {class: 'pc-paths-toggle'},
        btn(pathsOpen ? t('paths.hide') : t('paths.show'), {
          kind: 'ghost', size: 'sm', icon: 'eye', fk: 'paths',
          attrs: {'aria-expanded': String(pathsOpen)},
          onClick: () => { if (pathsOpen) delete S.pathsOpen[p.id]; else S.pathsOpen[p.id] = true; renderAll(); focusProjectControl(p.id, 'paths'); }
        })),
      pathsOpen ? projectPaths(p) : null);

    let strip = null;
    if (running && url) {
      const runLink = h('a', {class: 'run-url', href: url, target: '_blank', rel: 'noopener noreferrer', title: t('proj.openNewWin')}, icon('external'), h('span', {class: 'ltr'}, url));
      // a plain left click goes to the default browser; middle click / copy link keep working
      runLink.addEventListener('click', (ev) => {
        if (ev.button !== 0 || ev.ctrlKey || ev.shiftKey || ev.metaKey || ev.altKey) return;
        ev.preventDefault();
        openUrl(url);
      });
      strip = h('div', {class: ['run-strip', ext && 'is-external']},
        runLink,
        p.run && p.run.startedAt ? h('span', {class: 'run-meta'}, icon('clock'),
          h('span', {dataset: {since: p.run.startedAt, tpl: 'proj.runningFor'}}, t('proj.runningFor', {d: sinceText(p.run.startedAt)}))) : null,
        p.run && p.run.pid ? h('span', {class: 'run-meta mono'}, 'pid ' + p.run.pid) : null,
        ext ? h('span', {class: 'run-meta'}, icon('alert'), t('proj.extRun')) : null);
    }

    const lastRun = !running && !busy && p.lastStartedAt
      ? h('span', {class: 'muted small', dataset: {since: p.lastStartedAt, mode: 'ago', tpl: 'proj.lastRun'}}, t('proj.lastRun', {d: agoText(p.lastStartedAt)}))
      : null;
    const foot = h('div', {class: 'pc-foot'},
      btn(t('proj.openBrowser'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'globe', disabled: !(running && url), fk: 'browser', title: running ? t('proj.openBrowser') : t('proj.runFirst'), onClick: () => openUrl(url)}),
      menuButton(t('term.menu'), 'terminal', () => terminalItems(p), {fk: 'terminal'}),
      btn(t('pma.projBtn'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'db', fk: 'pma', disabled: !p.dbServerId,
        title: p.dbServerId ? t('pma.projTitle') : t('pma.noDbChosen'), onClick: (ev) => openPma({projectId: p.id}, ev.currentTarget)}),
      btn(t('proj.openFolder'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'folder', fk: 'folder', onClick: (ev) => openProjectFolder(p, ev.currentTarget)}),
      btn(t('proj.logs'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'log', fk: 'logs', onClick: () => openProjectLog(p)}),
      btn(t('proj.check'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'shield', fk: 'check', onClick: (ev) => runProjectJob(p, 'check', ev.currentTarget)}),
      btn(t('proj.lint'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'code', fk: 'lint', onClick: (ev) => runProjectJob(p, 'lint', ev.currentTarget)}),
      h('span', {class: 'pc-foot-sep', 'aria-hidden': 'true'}),
      btn(t('tm.btn') + (p.points && p.points.count ? ' · ' + Math.min(99, p.points.count) : ''), {kind: 'ghost', size: 'sm', icon: 'undo', fk: 'undo', disabled: !p.dbServerId,
        className: 'tm-btn',
        title: !p.dbServerId ? t('tm.needDb') : p.points && p.points.count ? tn('tm.btnTitleN', p.points.count) : t('tm.btnTitle'),
        onClick: () => openTimeMachine(p)}),
      btn(t('share.btn'), {kind: p.share ? 'primary' : 'ghost', size: 'sm', iconOnly: true, icon: 'share', fk: 'share',
        title: p.share ? t('share.btnOn') : t('share.btnTitle'), onClick: () => openShare(p)}),
      h('span', {class: 'spacer'}),
      lastRun,
      menuButton(t('common.more'), 'more', () => moreItems(p), {fk: 'more'}));

    return h('article', {class: ['card', 'project-card', running && 'is-running', busy && 'is-starting', wt.open && 'is-warn-open', p.share && 'is-shared'], 'aria-label': t('proj.cardAria', {name: p.name})},
      head, badges, fixBar, wt.panel, controls, strip, running ? shareStrip(p) : null, foot);
  }

  /* ----- actions ----- */
  function startPath(p) { return '/api/projects/' + enc(p.id) + '/start'; }
  /**
   * Start a project. `body` collects the answers given so far ({port}, {startDb}) so every follow-up
   * question (PORT_CONFIRM -> DB_STOPPED -> DB_MISSING) continues the same start.
   */
  async function startProject(p, body) {
    const b = body && typeof body === 'object' ? body : {};
    S.pending[p.id] = 'starting';
    renderAll();
    const r = await api('POST', startPath(p), b);
    if (r.ok) await refreshNow();
    delete S.pending[p.id];
    renderAll();
    return afterStart(p, r, b);
  }
  /** Handles a start/restart response: success toast, or the matching follow-up question. */
  async function afterStart(p, r, body) {
    if (r.ok) {
      const url = safeUrl(r.url) || safeUrl((findProject(p.id) || p).url);
      toast('success', t('proj.started', {name: p.name}), url, {actions: url ? [{label: t('proj.openBrowser'), onClick: () => openUrl(url)}] : []});
      if (r.portChanged) toast('warn', t('proj.portChanged'), url ? t('proj.portChangedMsg', {url}) : t('proj.portChangedMsgNoUrl'));
      // The DB_MISSING check could not run (e.g. login refused): the start was not blocked, but say so.
      if (typeof r.dbCheckWarning === 'string' && r.dbCheckWarning) toast('warn', t('proj.dbCheckSkipped'), bidi(r.dbCheckWarning), {duration: 9000});
      // The DB server was started for this run, or one already serving the same data was used.
      if (typeof r.dbNote === 'string' && r.dbNote) toast('info', t('proj.dbAuto'), bidi(r.dbNote), {duration: 8000});
      if (typeof r.dbEnvOverride === 'string' && r.dbEnvOverride) {
        toast('info', t('proj.dbEnvOverride'), bidi(r.dbEnvOverride), {
          duration: 12000,
          actions: Number.isInteger(r.dbEnvPort) ? [{label: t('proj.dbEnvWrite', {port: r.dbEnvPort}), onClick: () => fixEnvPort(findProject(p.id) || p, r.dbEnvPort)}] : []
        });
      }
      return;
    }
    if (r.code === 'PORT_CONFIRM') return askRunPort(p, r, body || {});
    if (r.code === 'DB_MISSING') return openDbMissing(p, r, body || {});
    if (r.code === 'DB_STOPPED') {
      const d = findServer(r.dbServerId || p.dbServerId);
      const label = d ? serverName(d) + ' (:' + d.port + ')' : t('proj.thisDb');
      const yes = await confirmDialog({
        title: t('proj.dbStoppedTitle'), icon: 'db', tone: 'warn', size: 'md',
        message: t('proj.dbStoppedMsg', {label}),
        details: d ? kvList([['Datadir', d.datadir || '-', true], ['my.ini', d.defaultsFile || '-', true]]) : null,
        confirmLabel: t('proj.dbStartRun'), confirmIcon: 'play'
      });
      if (yes) startProject(p, Object.assign({}, body, {startDb: true}));
      return;
    }
    if (r.code === 'START_FAILED') return showStartFailed(p, r);
    if (r.code === 'PHP_MISSING') {
      toast('error', t('proj.startFail', {name: p.name}), errorText(r), {
        duration: 9000,
        actions: [{label: t('proj.choosePhp'), onClick: () => focusProjectControl(p.id, 'php')}]
      });
      return;
    }
    failToast(t('proj.startFail', {name: p.name}), r);
  }
  /** Scroll to a project card and focus one of its controls (data-fk). */
  function focusProjectControl(id, fk) {
    if (S.page !== 'projects') goPage('projects');
    setTimeout(() => {
      const card = P.grid && P.grid.querySelector('[data-key="' + cssEsc(id) + '"]');
      if (!card) return;
      card.scrollIntoView({block: 'center', behavior: 'smooth'});
      const el = card.querySelector('[data-fk="' + cssEsc(fk) + '"]');
      if (el && !el.disabled) el.focus({preventScroll: true});
    }, 60);
  }
  function showStartFailed(p, r) {
    const tail = Array.isArray(r.logTail) ? r.logTail.join('\n') : (typeof r.logTail === 'string' ? r.logTail : '');
    openModal({
      title: t('proj.startFail', {name: p.name}), subtitle: p.path, icon: 'alert-circle', tone: 'bad', size: 'lg',
      body: [callout('bad', null, errorText(r)),
        tail ? h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('log.tail')), h('pre', {class: 'term-mini', dir: 'ltr'}, tail)) : null],
      actions: [
        {label: t('proj.fullLog'), icon: 'log', left: true, onClick: (m) => { m.close(); openProjectLog(p); }},
        {label: t('proj.runCheck'), icon: 'shield', onClick: (m) => { m.close(); runProjectJob(p, 'check', null); }},
        {label: t('common.ok'), kind: 'primary', value: null, autofocus: true}
      ]
    });
  }
  async function stopProject(p) {
    if (p.run && p.run.external) {
      const yes = await confirmDialog({
        title: t('ext.stopQ'), message: t('ext.stopMsg'), danger: true, icon: 'alert',
        details: kvList([[t('common.project'), p.name], [t('common.port'), ':' + p.port, true], ['pid', p.run.pid ? String(p.run.pid) : '-']]),
        confirmLabel: t('common.yesStop')
      });
      if (!yes) return;
    }
    S.pending[p.id] = 'stopping';
    renderAll();
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/stop');
    if (r.ok) await refreshNow();
    delete S.pending[p.id];
    renderAll();
    if (r.ok) toast('success', t('proj.stopped', {name: p.name}));
    else failToast(t('proj.stopFail', {name: p.name}), r);
  }
  async function restartProject(p) {
    S.pending[p.id] = 'starting';
    renderAll();
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/restart');
    if (r.ok) await refreshNow();
    delete S.pending[p.id];
    renderAll();
    if (r.ok) {
      toast('success', t('proj.restarted', {name: p.name}), safeUrl(r.url));
      if (typeof r.dbNote === 'string' && r.dbNote) toast('info', t('proj.dbAuto'), bidi(r.dbNote), {duration: 8000});
      if (typeof r.dbEnvOverride === 'string' && r.dbEnvOverride) toast('info', t('proj.dbEnvOverride'), bidi(r.dbEnvOverride), {duration: 12000});
    } else if (r.code === 'START_FAILED') showStartFailed(p, r);
    else if (r.code === 'PORT_CONFIRM' || r.code === 'DB_MISSING' || r.code === 'DB_STOPPED') afterStart(p, r, {});
    else failToast(t('proj.restartFail'), r);
  }
  async function updateProject(p, patch, okText) {
    S.busyUpdate[p.id] = true;
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/update', patch);
    if (r.ok) await refreshNow();
    delete S.busyUpdate[p.id];
    if (r.ok) {
      toast('success', okText || t('common.saved'), p.name);
    } else {
      failToast(t('common.saveFail'), r);
      // Show the saved value again: leave the edited control so the card can re-render.
      const a = document.activeElement;
      if (a && P.grid && P.grid.contains(a) && a.blur) a.blur();
    }
    renderAll();
  }
  async function editProjectPort(p) {
    const range = arr(S.state.settings.webPortRange);
    const from = range.length === 2 ? range[0] : 8000;
    const to = range.length === 2 ? range[1] : 8999;
    const v = await promptDialog({
      title: t('port.change'), subtitle: p.name, label: t('port.new'), type: 'number', value: String(p.port || ''), min: 1024, max: 65535, mono: true, icon: 'hash',
      hint: t('port.hintWeb', {from, to}),
      validate: (val) => {
        const n = validPort(val);
        if (!n) return t('port.invalid');
        const clash = S.state.projects.find((x) => x.id !== p.id && Number(x.port) === n);
        return clash ? t('port.taken', {name: clash.name}) : null;
      }
    });
    // Saving the same port still counts as "confirmed" when the project has never been asked (portConfirmed:false).
    if (v == null || (Number(v) === Number(p.port) && p.portConfirmed !== false)) return;
    updateProject(p, {port: Number(v)}, t('port.set', {port: v}));
  }
  function validateName(x) { return !x ? t('name.req') : x.length > 60 ? t('name.tooLong') : null; }
  async function renameProject(p) {
    const v = await promptDialog({
      title: t('common.rename'), subtitle: p.path, label: t('proj.nameLabel'), value: p.name, validate: validateName
    });
    if (v == null || v === p.name) return;
    updateProject(p, {name: v}, t('name.changed'));
  }
  async function removeProject(p) {
    const yes = await confirmDialog({
      title: t('remove.q'), danger: true, icon: 'trash',
      message: t('proj.removeMsg', {name: p.name}) + (isOn(p) ? ' ' + t('proj.removeRunning') : ''),
      confirmLabel: t('remove.yes')
    });
    if (!yes) return;
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/remove');
    if (!r.ok) return failToast(t('remove.fail'), r);
    toast('success', t('remove.done'), p.name);
    await refreshNow();
  }
  async function fixEnvPort(p, forcePort) {
    const port = Number.isInteger(forcePort) ? forcePort : Number(p.db && p.db.port);
    const env = (p.info && p.info.env) || {};
    const dataDir = S.state.panel.dataDir ? String(S.state.panel.dataDir).replace(/[\\/]+$/, '') : '';
    const backupDir = dataDir ? dataDir + '\\env-backups\\' + p.id + '\\' : t('env.backupDirFallback');
    const yes = await confirmDialog({
      title: t('env.q'), icon: 'pencil', tone: 'warn', size: 'md',
      message: env.port ? t('env.msgCur', {port, cur: env.port}) : t('env.msg', {port}),
      details: h('div', {class: 'stack'},
        callout('info', t('env.backupTitle'), h('div', null, t('env.backupWhere') + ' ', h('code', {class: 'break'}, backupDir))),
        p.info && p.info.configCached ? callout('warn', null, t('env.configCached')) : null),
      confirmLabel: t('env.yes'), confirmIcon: 'check'
    });
    if (!yes) return;
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/write-env-db', {port});
    if (!r.ok) return failToast(t('env.fail'), r);
    const lines = [];
    if (arr(r.changed).length) lines.push(t('env.changed', {list: arr(r.changed).join(', ')}));
    if (r.backup) lines.push(t('env.backup', {path: r.backup}));
    toast('success', t('env.done'), lines.join('\n'), {duration: 8000});
    await refreshNow();
  }
  async function openProjectFolder(p, b) {
    setBusy(b, true);
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/open-folder');
    setBusy(b, false);
    if (!r.ok) failToast(t('proj.folderFail'), r);
  }
  function openProjectLog(p) {
    openDrawer({
      title: t('proj.logTitle', {name: p.name}), subtitle: p.path, icon: 'log',
      fetch: async () => {
        const r = await api('GET', '/api/projects/' + enc(p.id) + '/log?lines=300');
        return r.ok ? {ok: true, text: r.text, size: r.size} : r;
      },
      onClear: () => api('POST', '/api/projects/' + enc(p.id) + '/log/clear')
    });
  }
  async function runProjectJob(p, kind, b) {
    if (b) setBusy(b, true);
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/' + kind);
    if (b) setBusy(b, false);
    if (!r.ok || !r.jobId) return failToast(t('job.startFail', {job: jobTitle(kind)}), r);
    showJob(r.jobId, {title: jobTitle(kind) + ' — ' + p.name, icon: JOB_ICONS[kind]});
  }
  function termLabel(a) { return a.labelKey ? t(a.labelKey) : a.label; }
  function terminalItems(p) {
    const desc = 'PHP ' + (p.phpVersion || '?') + (p.composer && p.composer.version ? ' · Composer ' + p.composer.version : '');
    const items = [{heading: t('term.heading', {desc})}];
    for (const a of TERMINAL_ACTIONS) {
      const noComposer = a.needsComposer && !p.composerId;
      const noLaravel = a.needsLaravel && !(p.info && p.info.isLaravel);
      items.push({
        label: termLabel(a), icon: a.icon, disabled: noComposer || noLaravel,
        title: noComposer ? t('term.needComposer') : noLaravel ? t('term.notLaravel') : null,
        hint: a.action === 'shell' ? null : a.needsComposer ? 'composer' : 'artisan',
        onClick: () => openTerminal(p, a)
      });
      if (a.action === 'shell') items.push('sep');
    }
    return items;
  }
  async function openTerminal(p, a) {
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/terminal', {action: a.action});
    if (!r.ok) return failToast(t('term.fail'), r);
    toast('info', t('term.opening'), a.action === 'shell'
      ? t('term.shellMsg', {name: p.name, v: p.phpVersion || ''})
      : t('term.cmdMsg', {label: termLabel(a)}));
  }
  function moreItems(p) {
    const on = isOn(p);
    const laravel = !!(p.info && p.info.isLaravel);
    return [
      {label: t('pma.projBtn'), icon: 'db', hint: 'phpMyAdmin', disabled: !p.dbServerId, title: p.dbServerId ? null : t('pma.noDbChosen'), onClick: () => openPma({projectId: p.id}, null)},
      {label: t('tm.menu'), icon: 'undo', hint: p.points && p.points.count ? String(p.points.count) : null, disabled: !p.dbServerId, title: p.dbServerId ? null : t('tm.needDb'), onClick: () => openTimeMachine(p)},
      p.share
        ? {label: t('share.stop'), icon: 'stop', onClick: () => stopShare(p, null)}
        : {label: t('share.menu'), icon: 'share', hint: 'trycloudflare.com', onClick: () => openShare(p)},
      {label: t('team.menuExport'), icon: 'users', hint: 'phpstation.json', onClick: () => openTeamExport(p)},
      'sep',
      {label: t('ib.menuMail'), icon: 'mail', onClick: () => openInbox('mail', p.id)},
      {label: t('ib.menuDumps'), icon: 'code', onClick: () => openInbox('dumps', p.id)},
      {label: t('ib.menuErrors'), icon: 'bug', hint: p.newErrors ? String(p.newErrors) : null, onClick: () => openInbox('errors', p.id)},
      'sep',
      {label: t('common.rename'), icon: 'pencil', onClick: () => renameProject(p)},
      {label: t('port.change'), icon: 'hash', disabled: on, title: on ? t('proj.stopFirst') : null, onClick: () => editProjectPort(p)},
      {label: t('proj.restart'), icon: 'refresh', disabled: p.status !== 'running', onClick: () => restartProject(p)},
      {label: t('proj.clearCache'), icon: 'eraser', hint: 'optimize:clear', disabled: !laravel, title: laravel ? null : t('term.notLaravel'), onClick: () => runProjectJob(p, 'clear-cache', null)},
      {label: t('proj.copyPath'), icon: 'copy', onClick: () => copyText(p.path).then((ok) => toast(ok ? 'success' : 'warn', ok ? t('copy.pathDone') : t('copy.fail'), p.path))},
      'sep',
      {label: t('remove.menu'), icon: 'trash', danger: true, onClick: () => removeProject(p)}
    ];
  }

  /* ===================== First run: which port? (PORT_CONFIRM) ===================== */
  const PORT_INPUT_CODES = ['PORT_BUSY', 'PORT_TAKEN', 'BAD_INPUT'];
  function askRunPort(p, r, body) {
    const range = arr(S.state && S.state.settings.webPortRange);
    const from = range.length === 2 ? range[0] : 8000;
    const to = range.length === 2 ? range[1] : 8999;
    const suggested = validPort(r.suggestedPort) || validPort(p.port) || '';
    const input = h('input', {
      class: 'input mono rp-input', id: uid('rp'), type: 'number', min: 1024, max: 65535, inputmode: 'numeric',
      value: String(suggested), autocomplete: 'off', dataset: {autofocus: '1'}
    });
    const urlText = h('span', {class: 'mono'});
    const showUrl = () => {
      const n = validPort(input.value);
      urlText.textContent = n ? 'http://127.0.0.1:' + n : '—';
    };
    showUrl();
    const err = h('div', {class: 'field-error', 'aria-live': 'polite'});
    let m = null;
    const submit = async () => {
      err.textContent = '';
      input.classList.remove('is-invalid');
      const n = validPort(input.value);
      const clash = n ? S.state.projects.find((x) => x.id !== p.id && Number(x.port) === n) : null;
      const problem = !n ? t('port.invalid') : clash ? t('port.taken', {name: clash.name}) : null;
      if (problem) { err.textContent = problem; input.classList.add('is-invalid'); input.focus(); return; }
      const next = Object.assign({}, body, {port: n});
      S.pending[p.id] = 'starting';
      renderAll();
      const r2 = await modalBusy(m, m.button('go'), t('rp.starting'), () => api('POST', startPath(p), next));
      delete S.pending[p.id];
      if (!r2.ok && PORT_INPUT_CODES.includes(r2.code)) {
        renderAll();
        err.textContent = errorText(r2);
        input.classList.add('is-invalid');
        input.focus();
        return;
      }
      m.close(true);
      if (r2.ok) await refreshNow();
      renderAll();
      afterStart(p, r2, next);
    };
    m = openModal({
      title: t('rp.title'), subtitle: p.name, icon: 'hash', size: 'sm',
      body: [
        h('p', {class: 'modal-text'}, t('rp.text')),
        h('div', {class: 'field'},
          h('label', {class: 'field-label', for: input.id}, t('common.port')),
          input,
          h('div', {class: 'field-hint'}, t('port.hintWeb', {from, to})),
          err),
        h('div', {class: 'rp-url'}, icon('globe'), h('span', {class: 'muted'}, t('rp.url')), urlText),
        callout('info', null, h('div', null, t('rp.remember'), ' ', h('span', {class: 'rp-pencil'}, icon('pencil'), t('port.change'))))
      ],
      actions: [{label: t('common.cancel'), value: null}, {id: 'go', label: t('rp.go'), kind: 'primary', icon: 'play', onClick: submit}]
    });
    input.addEventListener('input', () => { err.textContent = ''; input.classList.remove('is-invalid'); showUrl(); });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    setTimeout(() => { try { input.select(); } catch (e) { /* number input */ } }, 0);
    return m.result;
  }

  /* ===================== Database missing on the project's server (DB_MISSING) ===================== */
  function openDbMissing(p, r, body) {
    const dbName = String(r.database || ((p.info && p.info.env && p.info.env.database) || ''));
    const server = findServer(r.dbServerId || p.dbServerId);
    const serverLabel = server ? serverName(server) + ' :' + server.port : t('proj.thisDb');
    const found = arr(r.foundOn).filter((x) => x && x.serverId);
    let mode = found.length ? 'move' : 'import';
    const group = uid('dbm');
    const err = h('div', {class: 'field-error', 'aria-live': 'polite'});

    // 1. move from a running server that has it
    const fromSel = h('select', {class: 'select', id: uid('dbmf'), 'aria-label': t('dbm.fromAria')});
    for (const f of found) {
      const size = f.sizeMB != null ? ' · ' + fmtMB(f.sizeMB) : ''; // option text: the select is LTR in Urdu too
      fromSel.appendChild(h('option', {value: f.serverId}, (f.label || f.serverId) + ' · :' + f.port + size));
    }
    const moveExtra = found.length
      ? h('div', {class: 'stack'}, field(t('dbm.fromLabel'), fromSel), h('p', {class: 'field-hint'}, t('dbm.moveKeep')))
      : callout('info', null, t('dbm.noneFound', {db: dbName}),
        [btn(t('dbm.openDbPage'), {size: 'sm', icon: 'db', onClick: () => { m.close(null); goPage('db'); }})]);
    // 2. import a .sql file
    const fileInput = h('input', {class: 'input mono', id: uid('dbmi'), type: 'text', placeholder: t('dbm.filePh'), autocomplete: 'off', spellcheck: 'false'});
    const browse = btn(t('common.browse'), {icon: 'folder'});
    browse.addEventListener('click', async () => {
      const cur = fileInput.value.trim();
      setBusy(browse, true, t('np.windowOpening'));
      const res = await api('POST', '/api/pick-file', cur && !validateWinPath(cur) ? {kind: 'sql', start: dirOf(cur)} : {kind: 'sql'});
      setBusy(browse, false);
      if (m.closed) return;
      if (!res.ok) return failToast(t('dbm.pickFail'), res);
      if (res.path) { fileInput.value = res.path; err.textContent = ''; fileInput.classList.remove('is-invalid'); }
    });
    fileInput.addEventListener('input', () => { err.textContent = ''; fileInput.classList.remove('is-invalid'); });
    const importExtra = h('div', {class: 'stack'},
      h('div', {class: 'field'}, h('label', {class: 'field-label', for: fileInput.id}, t('dbm.fileLabel')),
        h('div', {class: 'input-row'}, fileInput, browse)),
      h('p', {class: 'field-hint'}, t('dbm.importHint')));

    const choices = [
      {id: 'move', icon: 'move', title: t('dbm.optMove'), desc: found.length ? tn('dbm.optMoveDesc', found.length) : t('dbm.optMoveNone'), extra: moveExtra, disabled: !found.length},
      {id: 'import', icon: 'file', title: t('dbm.optImport'), desc: t('dbm.optImportDesc'), extra: importExtra},
      {id: 'empty', icon: 'db', title: t('dbm.optEmpty'), desc: t('dbm.optEmptyDesc'), extra: null}
    ];
    const views = choices.map((c) => {
      const radio = h('input', {type: 'radio', name: group, value: c.id, checked: mode === c.id, disabled: !!c.disabled, class: 'choice-radio', id: uid('dbmr')});
      const extra = c.extra ? h('div', {class: 'choice-extra'}, c.extra) : null;
      const el = h('div', {class: ['choice', c.disabled && 'is-disabled'], dataset: {choice: c.id}},
        h('label', {class: 'choice-head', for: radio.id}, radio,
          h('span', {class: 'choice-icon'}, icon(c.icon)),
          h('span', {class: 'choice-main'}, h('span', {class: 'choice-title'}, c.title), h('span', {class: 'choice-desc'}, c.desc))),
        extra);
      radio.addEventListener('change', () => { if (radio.checked) select(c.id); });
      return {c, el, radio, extra};
    });
    function select(id) {
      mode = id;
      err.textContent = '';
      for (const v of views) {
        const on = v.c.id === id;
        v.radio.checked = on;
        v.el.classList.toggle('is-selected', on);
        // A disabled choice keeps its note visible (it says why and where to go).
        if (v.extra) v.extra.hidden = !on && !v.c.disabled;
      }
      const go = m && m.button('go');
      if (go) {
        const lbl = go.querySelector('.btn-label');
        if (lbl) lbl.textContent = t('dbm.go.' + id);
      }
    }

    let m = null;
    const submit = async () => {
      err.textContent = '';
      const payload = {mode};
      if (mode === 'move') {
        if (!found.length || !fromSel.value) { err.textContent = t('dbm.noneFoundShort'); return; }
        payload.fromServerId = fromSel.value;
      } else if (mode === 'import') {
        const f = fileInput.value.trim();
        const problem = validateWinPath(f) || (/\.sql$/i.test(f) ? null : t('dbm.notSql'));
        if (problem) { err.textContent = problem; fileInput.classList.add('is-invalid'); fileInput.focus(); return; }
        payload.file = f;
      }
      const res = await modalBusy(m, m.button('go'), t('common.startingShort'), () => api('POST', '/api/projects/' + enc(p.id) + '/db-provision', payload));
      if (!res.ok || !res.jobId) { err.textContent = errorText(res); return; }
      m.close(true);
      runProvisionJob(p, res.jobId, mode, dbName, serverLabel, body);
    };
    m = openModal({
      title: t('dbm.title', {db: dbName, server: serverLabel}), subtitle: p.name, icon: 'db', tone: 'warn', size: 'lg',
      body: [
        h('p', {class: 'modal-text'}, t('dbm.text', {db: dbName})),
        h('div', {class: 'choices', role: 'radiogroup', 'aria-label': t('dbm.choiceAria')}, views.map((v) => v.el)),
        h('p', {class: 'dbm-never'}, icon('lock'), t('dbm.never')),
        err
      ],
      actions: [{label: t('common.notNow'), value: null}, {id: 'go', label: t('dbm.go.' + mode), kind: 'primary', icon: 'play', onClick: submit}]
    });
    select(mode);
    return m.result;
  }
  /** Progress for the db-provision job: import size %, or the dump size while a move runs. */
  function provisionProgress(job, mode) { return jobProgress(job, mode === 'import'); }
  /** The dump of a "move" keeps real data in the backups folder: say where, offer to delete it. */
  function dumpNote(file) {
    const box = h('div');
    const del = btn(t('mv.deleteDump'), {size: 'sm', kind: 'soft-danger', icon: 'trash', onClick: async () => {
      const yes = await confirmDialog({title: t('mv.delQ'), danger: true, icon: 'trash', message: t('mv.delMsg'), details: h('code', {class: 'break'}, file), confirmLabel: t('mv.delYes')});
      if (!yes) return;
      setBusy(del, true);
      const r = await api('POST', '/api/dumps/delete', {file});
      setBusy(del, false);
      if (!r.ok) return failToast(t('mv.delFail'), r);
      toast('success', t('mv.delDone'));
      box.replaceChildren(callout('ok', null, t('mv.dumpDeleted')));
    }});
    box.appendChild(callout('warn', t('mv.dumpHasData'),
      h('div', {class: 'pc-path'}, h('code', {class: 'break'}, file), copyButton(file, t('mv.copyDump'))), [del]));
    return box;
  }
  function provisionResult(job, mode, dbName) {
    if (job.status !== 'done') return null;
    const res = job.result && typeof job.result === 'object' ? job.result : {};
    const rows = normalizeTableRows(res);
    const tableCount = typeof res.tables === 'number' ? res.tables : typeof res.tableCount === 'number' ? res.tableCount : rows.length || null;
    const size = res.sizeMB != null ? fmtMB(res.sizeMB) : res.bytes != null ? fmtBytes(res.bytes) : res.dumpBytes != null ? fmtBytes(res.dumpBytes) : null;
    const totalRows = typeof res.rows === 'number' ? res.rows : null;
    const chips = [
      tableCount != null && mode !== 'empty' ? chip(tn('mv.tablesN', tableCount, {n: fmtInt(tableCount)}), {kind: 'ok', icon: 'list'}) : null,
      totalRows != null ? chip(tn('mv.rowsN', totalRows, {n: fmtInt(totalRows)}), {kind: 'ok', icon: 'db'}) : null,
      size ? chip(iso(size), {kind: 'ok', icon: 'download'}) : null
    ].filter(Boolean);
    return h('div', {class: 'stack'},
      callout('ok', t('dbm.okTitle', {db: dbName}), chips.length ? h('div', {class: 'result-summary'}, chips) : t('dbm.okEmpty')),
      mode === 'move' && rows.length ? tableCountsView(rows) : null,
      mode === 'move' && typeof res.dumpFile === 'string' && res.dumpFile ? dumpNote(res.dumpFile) : null,
      h('p', {class: 'muted small'}, t('dbm.continuing')));
  }
  function provisionDoneText(job, mode) {
    const res = job.result && typeof job.result === 'object' ? job.result : {};
    const n = typeof res.tables === 'number' ? res.tables : typeof res.tableCount === 'number' ? res.tableCount : normalizeTableRows(res).length || null;
    return n != null && mode !== 'empty' ? tn('mv.tablesN', n, {n: fmtInt(n)}) : null;
  }
  function runProvisionJob(p, jobId, mode, dbName, serverLabel, body) {
    showJob(jobId, {
      title: t('dbm.job.' + mode, {db: dbName}), subtitle: p.name + ' · ' + serverLabel,
      icon: mode === 'move' ? 'move' : mode === 'import' ? 'file' : 'db',
      progress: (job) => provisionProgress(job, mode),
      renderResult: (job) => provisionResult(job, mode, dbName),
      doneMessage: (job) => provisionDoneText(job, mode),
      // A move leaves a dump with real data behind: keep the log open so its note (and delete button) is seen.
      closeOnDone: mode !== 'move',
      onFinal: async (job) => {
        if (job.status !== 'done') return;
        await refreshNow();
        // The database exists now: continue the start the user asked for.
        startProject(findProject(p.id) || p, body);
      }
    });
  }

  /* ===================== Setup suggestions ("Setup" tag + checklist) ===================== */
  const SETUP_ORDER = ['CREATE_ENV', 'SET_DB', 'SET_APP_URL', 'GENERATE_KEY', 'COMPOSER_INSTALL'];
  const SETUP_ICON = {CREATE_ENV: 'file', SET_DB: 'db', SET_APP_URL: 'globe', GENERATE_KEY: 'key', COMPOSER_INSTALL: 'package'};
  function sortActions(list) {
    const known = SETUP_ORDER.filter((c) => list.includes(c));
    return known.concat(list.filter((c) => typeof c === 'string' && !SETUP_ORDER.includes(c)));
  }
  /** What the suggestions depend on; a change here (not a poll) triggers one new GET. */
  function setupInputSig(p) {
    const info = p.info || {};
    const d = p.dbServerId ? findServer(p.dbServerId) : null;
    return JSON.stringify([p.path, p.port, p.portConfirmed, p.dbServerId, d ? d.port : null, p.composerId, p.phpPath,
      info.env || null, !!info.vendor, !!info.isLaravel]);
  }
  function setupActions(id) {
    const s = S.setup[id];
    return s && s.data ? sortActions(arr(s.data.actions)) : [];
  }
  function setupCardSig(id) { return setupActions(id).join(',') + (S.setupJobs[id] ? '|job' : ''); }
  function ensureSetup(p, force) {
    if (!p || !p.id) return null;
    const sig = setupInputSig(p);
    const cur = S.setup[p.id];
    if (cur && !force && cur.sig === sig) return cur.promise || null;
    const entry = {sig, loading: true, data: cur ? cur.data : null};
    S.setup[p.id] = entry;
    entry.promise = api('GET', '/api/projects/' + enc(p.id) + '/setup').then((r) => {
      if (S.setup[p.id] !== entry) return r;
      entry.loading = false;
      // An older backend (no /setup route) or a failure simply shows no tag.
      entry.data = r.ok ? r : null;
      if (S.state && P.grid && S.mountedPage === 'projects') updateProjects(S.state);
      return r;
    });
    return entry.promise;
  }
  function setupTag(p) {
    const acts = setupActions(p.id);
    const jobId = S.setupJobs[p.id];
    if (!acts.length && !jobId) return null;
    const label = jobId ? t('setup.tagRunning') : t('setup.tag');
    const b = h('button', {
      type: 'button', class: ['chip', 'setup-tag'], 'aria-haspopup': 'dialog', dataset: {fk: 'setup'},
      title: jobId ? t('setup.tagRunningTitle') : tn('setup.tagTitle', acts.length)
    }, jobId ? spinner() : icon('wand'), h('span', null, label), jobId ? null : h('span', {class: 'setup-count'}, String(acts.length)));
    b.addEventListener('click', () => {
      if (S.setupJobs[p.id]) showSetupJob(p, S.setupJobs[p.id], null);
      else openSetupChecklist(p);
    });
    return b;
  }
  function setupItemText(code, p, data) {
    const env = data.env || {};
    const server = data.server || null;
    switch (code) {
      case 'SET_DB': {
        const port = server && server.port ? server.port : (p.db && p.db.port) || '?';
        return t('setup.d.SET_DB', {port, db: env.dbDatabase || t('setup.dbFromName')});
      }
      case 'SET_APP_URL': return t('setup.d.SET_APP_URL', {url: 'http://127.0.0.1:' + (data.projectPort || p.port || '?')});
      case 'COMPOSER_INSTALL': {
        const c = p.composer && p.composer.version ? 'Composer ' + p.composer.version : 'Composer';
        return t('setup.d.COMPOSER_INSTALL', {composer: c, php: 'PHP ' + (p.phpVersion || '?')});
      }
      default: return hasT('setup.d.' + code) ? t('setup.d.' + code) : '';
    }
  }
  /**
   * Checklist modal: every suggested action pre-ticked -> POST /api/projects/:id/setup as a job.
   * o: {data (a fresh GET result), isNew, after()} — after() runs when the user skips or the job succeeds.
   */
  async function openSetupChecklist(p0, o) {
    const opts = o || {};
    const p = findProject(p0.id) || p0;
    let data = opts.data || null;
    if (!data) {
      const r = await ensureSetup(p, true);
      if (!r || !r.ok) { failToast(t('setup.loadFail'), r || {}); return; }
      data = r;
    }
    const acts = sortActions(arr(data.actions));
    if (!acts.length) {
      toast('success', t('setup.nothing'), p.name);
      if (opts.after) opts.after();
      return;
    }
    const rows = acts.map((code) => {
      const blocked = code === 'COMPOSER_INSTALL' && data.composerSelected === false;
      const cb = h('input', {type: 'checkbox', checked: !blocked, disabled: blocked, id: uid('sc'), dataset: {code}});
      const title = hasT('setup.a.' + code) ? t('setup.a.' + code) : code;
      const desc = blocked ? t('setup.needComposer') : setupItemText(code, p, data);
      const el = h('label', {class: ['check-item', blocked && 'is-blocked'], for: cb.id},
        cb, h('span', {class: 'check-icon'}, icon(SETUP_ICON[code] || 'wand')),
        h('span', {class: 'check-main'}, h('span', {class: 'check-title'}, title), desc ? h('span', {class: 'check-desc'}, bidi(desc)) : null));
      return {code, cb, el};
    });
    const err = h('div', {class: 'field-error', 'aria-live': 'polite'});
    const dataDir = S.state && S.state.panel.dataDir ? String(S.state.panel.dataDir).replace(/[\\/]+$/, '') : '';
    const backupDir = dataDir ? dataDir + '\\env-backups\\' + p.id + '\\' : t('env.backupDirFallback');
    const touchesEnv = acts.some((c) => c !== 'COMPOSER_INSTALL');
    let submitted = false;
    let m = null;
    const chosen = () => rows.filter((x) => x.cb.checked && !x.cb.disabled).map((x) => x.code);
    const syncButton = () => {
      const n = chosen().length;
      const b = m && m.button('go');
      if (!b) return;
      b.disabled = n === 0;
      const lbl = b.querySelector('.btn-label');
      const selectable = rows.filter((x) => !x.cb.disabled).length;
      if (lbl) lbl.textContent = n === selectable ? t('setup.goAll') : tn('setup.goSome', n);
    };
    for (const x of rows) x.cb.addEventListener('change', () => { err.textContent = ''; syncButton(); });
    const submit = async () => {
      const list = chosen();
      if (!list.length) { err.textContent = t('setup.noneChosen'); return; }
      const r = await modalBusy(m, m.button('go'), t('common.startingShort'), () => api('POST', '/api/projects/' + enc(p.id) + '/setup', {actions: list}));
      if (!r.ok || !r.jobId) { err.textContent = errorText(r); return; }
      submitted = true;
      m.close(true);
      S.setupJobs[p.id] = r.jobId;
      if (S.state && P.grid) updateProjects(S.state);
      showSetupJob(p, r.jobId, opts.after || null);
    };
    m = openModal({
      title: t('setup.title'), subtitle: p.name, icon: 'wand', size: 'md',
      body: [
        h('p', {class: 'modal-text'}, opts.isNew ? t('setup.introNew') : t('setup.intro')),
        h('div', {class: 'check-list'}, rows.map((x) => x.el)),
        touchesEnv ? callout('info', t('env.backupTitle'), h('div', null, t('env.backupWhere') + ' ', h('code', {class: 'break'}, backupDir))) : null,
        err
      ],
      actions: [
        {label: opts.after && opts.isNew ? t('setup.skipRun') : t('setup.later'), value: null},
        {id: 'go', label: t('setup.goAll'), kind: 'primary', icon: 'wand', onClick: submit}
      ],
      onClose: () => { if (!submitted && opts.after) setTimeout(opts.after, 0); }
    });
    syncButton();
  }
  function actionTitle(code) { return hasT('setup.a.' + code) ? t('setup.a.' + code) : String(code); }
  function setupResult(job) {
    const res = job.result && typeof job.result === 'object' ? job.result : {};
    const out = genericResult(job);
    const backups = arr(res.backups).concat(res.backup ? [res.backup] : []).filter((x) => typeof x === 'string' && x);
    if (job.status === 'done') {
      const chips = arr(res.done).map((c) => chip(actionTitle(c), {kind: 'ok', icon: 'check'}))
        .concat(arr(res.skipped).map((c) => chip(actionTitle(c), {icon: 'info', title: t('setup.skippedTitle')})));
      out.unshift(callout('ok', t('setup.doneTitle'), h('div', {class: 'stack'},
        chips.length ? h('div', {class: 'result-summary'}, chips) : null,
        res.configCleared ? h('div', null, t('setup.configCleared')) : null,
        backups.length ? h('div', null, t('env.backupWhere') + ' ', h('code', {class: 'break'}, backups[backups.length - 1])) : null)));
    }
    return out.length ? h('div', {class: 'stack'}, out) : null;
  }
  function setupProgress(job) {
    const pr = job && job.status === 'running' && job.progress && typeof job.progress === 'object' ? job.progress : null;
    if (!pr || !Number(pr.total)) return null;
    const done = Math.max(0, Number(pr.done) || 0);
    return {pct: (done / Number(pr.total)) * 100, label: pr.stage && pr.stage !== 'done' ? actionTitle(pr.stage) : null, text: done + ' / ' + Number(pr.total)};
  }
  function showSetupJob(p, jobId, after) {
    return showJob(jobId, {
      title: t('setup.jobTitle', {name: p.name}), icon: 'wand',
      progress: setupProgress,
      renderResult: setupResult,
      onFinal: async (job) => {
        delete S.setupJobs[p.id];
        await refreshNow();
        await ensureSetup(findProject(p.id) || p, true);
        if (job.status === 'done' && after) after();
      }
    });
  }

  /* ===================== Naya project modal ===================== */
  function newestComposerId() {
    const list = okComposer().slice().sort((a, b) => compareVer(b.version, a.version));
    return list.length ? list[0].id : null;
  }
  function fillComposerOptions(sel, selected) {
    sel.replaceChildren(h('option', {value: ''}, t('common.none')));
    for (const c of okComposer().slice().sort((a, b) => compareVer(b.version, a.version))) {
      sel.appendChild(h('option', {value: c.id, title: c.path}, composerOptionLabel(c)));
    }
    sel.value = selected && okComposer().some((c) => c.id === selected) ? selected : '';
  }
  function fillDbOptions(sel, selected) {
    sel.replaceChildren(h('option', {value: ''}, t('db.noneEnv')));
    for (const d of S.state.dbServers) {
      sel.appendChild(h('option', {value: d.id}, dbOptionLabel(d)));
    }
    sel.value = selected && findServer(selected) ? selected : '';
  }
  function factsView(info) {
    const env = info.env || {};
    const lv = info.laravelLocked || info.laravelInstalled || info.laravel || null;
    const ext = arr(info.requiredExt).map((e) => String(e).replace(/^ext-/, ''));
    const facts = [
      [t('facts.kind'), info.isLaravel ? 'Laravel' : t('proj.plainPhp'), null],
      info.isLaravel ? ['Laravel', lv || info.laravelConstraint || '?', lv ? 'ok' : 'warn', true] : null,
      [t('facts.phpReq'), info.composerPhp || t('facts.notWritten'), null, !!info.composerPhp],
      [t('facts.vendor'), info.vendor ? t('facts.present') : t('facts.absent'), info.vendor ? 'ok' : (info.isLaravel ? 'warn' : null)],
      ['Router', routerLabel(info.router), null],
      [t('facts.envDb'), env.exists ? (env.host || '?') + ':' + (env.port || '?') : t('facts.noEnv'), env.exists ? null : 'warn', !!env.exists],
      env.exists ? [t('common.database'), env.database || '-', null, true] : null,
      env.exists && env.username ? [t('facts.dbUser'), env.username + ' ' + (env.passwordSet ? t('facts.passSet') : t('facts.passEmpty')), null] : null,
      info.configCached ? ['Config cache', t('facts.cached'), 'warn'] : null,
      ext.length ? ['Extensions', ext.join(', '), null, true] : null
    ].filter(Boolean);
    return h('div', {class: 'facts'}, facts.map((f) => h('div', {class: 'fact'},
      h('span', {class: 'fact-k'}, f[0]), h('span', {class: ['fact-v', f[2] && 'is-' + f[2], f[3] && 'ltr']}, f[1]))));
  }

  function openAddProject(prefillPath) {
    let inspectSeq = 0;
    let nameTouched = false;
    let lastInspected = '';
    const pathInput = h('input', {
      class: 'input mono', id: uid('np'), type: 'text', placeholder: t('np.pathPh'),
      autocomplete: 'off', spellcheck: 'false', value: prefillPath || '', dataset: {autofocus: '1'}
    });
    const browseBtn = btn(t('common.browse'), {icon: 'folder'});
    const pathErr = h('div', {class: 'field-error', 'aria-live': 'polite'});
    const factsBox = h('div', {'aria-live': 'polite'});
    const nameInput = h('input', {class: 'input', id: uid('nn'), type: 'text', autocomplete: 'off', placeholder: t('np.namePh')});
    const phpSel = h('select', {class: 'select', id: uid('nphp')});
    const compSel = h('select', {class: 'select', id: uid('ncomp')});
    const dbSel = h('select', {class: 'select', id: uid('ndb')});
    const formErr = h('div', {class: 'field-error', 'aria-live': 'polite'});
    fillPhpOptions(phpSel, [], null);
    fillComposerOptions(compSel, newestComposerId());
    fillDbOptions(dbSel, null);
    nameInput.addEventListener('input', () => { nameTouched = nameInput.value.trim() !== ''; });
    // Once the user picks a PHP / DB server, an inspect result arriving later must not overwrite it.
    let phpTouched = false;
    let dbTouched = false;
    phpSel.addEventListener('change', () => { phpTouched = true; });
    dbSel.addEventListener('change', () => { dbTouched = true; });

    let m = null;
    const inspect = async () => {
      const path = pathInput.value.trim();
      if (path === lastInspected) return;
      const problem = validateWinPath(path);
      if (problem) {
        pathErr.textContent = path ? problem : '';
        factsBox.replaceChildren();
        lastInspected = '';
        return;
      }
      lastInspected = path;
      pathErr.textContent = '';
      const seq = ++inspectSeq;
      factsBox.replaceChildren(h('div', {class: 'row muted small'}, spinner(), t('np.reading')));
      const r = await api('POST', '/api/projects/inspect', {path});
      if (seq !== inspectSeq || m.closed) return;
      if (!r.ok) {
        factsBox.replaceChildren(callout('bad', t('np.readFail'), errorText(r)));
        lastInspected = '';
        return;
      }
      const info = r.info || {};
      const sugg = r.suggestions || {};
      if (info.exists === false) {
        factsBox.replaceChildren(callout('bad', null, t('np.notExist')));
        return;
      }
      if (!nameTouched) nameInput.value = info.name || baseName(path);
      const dupe = S.state.projects.find((x) => normPath(x.path) === normPath(path));
      factsBox.replaceChildren(
        info.teamFile ? callout('ok', t('team.foundTitle'), t('team.foundText'),
          [btn(t('team.foundBtn'), {kind: 'primary', size: 'sm', icon: 'bolt', onClick: () => { m.close(); openTeamPlan(path); }})]) : null,
        dupe ? callout('warn', t('np.dupeTitle'), t('np.dupeMsg', {name: dupe.name})) : null,
        factsView(info));
      fillPhpOptions(phpSel, arr(sugg.php), phpTouched ? phpSel.value : null);
      if (!dbTouched && sugg.dbServerId && findServer(sugg.dbServerId)) dbSel.value = sugg.dbServerId;
    };
    const inspectSoon = debounce(inspect, 450);
    pathInput.addEventListener('input', inspectSoon);
    pathInput.addEventListener('change', () => { inspectSoon.cancel(); inspect(); });
    pathInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); inspectSoon.cancel(); inspect(); } });
    browseBtn.addEventListener('click', async () => {
      const cur = pathInput.value.trim();
      setBusy(browseBtn, true, t('np.windowOpening'));
      const r = await api('POST', '/api/pick-folder', cur && !validateWinPath(cur) ? {start: cur} : {});
      setBusy(browseBtn, false);
      if (m.closed) return;
      if (!r.ok) return failToast(t('np.pickFail'), r);
      if (r.path) { pathInput.value = r.path; inspectSoon.cancel(); inspect(); }
    });

    const save = async (andRun) => {
      formErr.textContent = '';
      const path = pathInput.value.trim();
      const problem = validateWinPath(path);
      if (problem) { pathErr.textContent = problem; pathInput.focus(); return; }
      const rt = okPhp().find((x) => x.path === phpSel.value);
      if (!rt) { formErr.textContent = t('np.phpReq'); return; }
      const body = {path, phpVersion: rt.version, phpPath: rt.path, composerId: compSel.value || null, dbServerId: dbSel.value || null};
      const name = nameInput.value.trim();
      if (name) body.name = name;
      const r = await modalBusy(m, m.button(andRun ? 'run' : 'save'), t('common.saving'), () => api('POST', '/api/projects', body));
      if (!r.ok) { formErr.textContent = errorText(r); return; }
      m.close(true);
      const proj = r.project || null;
      toast('success', t('np.added'), proj ? proj.name + (proj.port ? ' · port ' + proj.port : '') : null);
      if (proj) S.flash = proj.id;
      if (S.page !== 'projects') goPage('projects');
      await refreshNow();
      if (!proj) return;
      const fresh = findProject(proj.id) || proj;
      const run = andRun ? () => startProject(findProject(proj.id) || fresh) : null;
      // Offer "Sab khud set karein" right away when PHP Station can set up .env / key / vendor for this project.
      const st = await ensureSetup(fresh, true);
      if (st && st.ok && arr(st.actions).length) openSetupChecklist(fresh, {data: st, isNew: true, after: run});
      else if (run) run();
    };

    m = openModal({
      title: t('proj.new'), subtitle: t('np.sub'),
      icon: 'plus', size: 'lg',
      body: [
        h('div', {class: 'field'}, h('label', {class: 'field-label', for: pathInput.id}, t('np.folder')),
          h('div', {class: 'input-row'}, pathInput, browseBtn), pathErr),
        factsBox,
        h('div', {class: 'form-grid'},
          field(t('common.name'), nameInput, 'span-2'),
          field('PHP', phpSel, null, t('np.phpHint')),
          field('Composer', compSel),
          field(t('field.db'), dbSel, 'span-2', t('np.dbHint'))),
        formErr
      ],
      actions: [
        {label: t('common.cancel'), value: null},
        {id: 'save', label: t('common.save'), icon: 'check', onClick: () => save(false)},
        {id: 'run', label: t('np.saveRun'), kind: 'primary', icon: 'play', onClick: () => save(true)}
      ]
    });
    if (prefillPath) inspect();
  }

  /* ===================== Folders scan modal ===================== */
  async function openScanProjects() {
    const body = h('div', {class: 'stack'}, h('div', {class: 'row muted'}, spinner(), t('scan.searching')));
    let rows = [];
    const m = openModal({
      title: t('proj.scan'), subtitle: t('scan.sub'),
      icon: 'folder-search', size: 'xl', body,
      actions: [{label: t('common.close'), value: null}, {id: 'add', label: t('scan.addSelected'), kind: 'primary', icon: 'plus', disabled: true, onClick: () => addSelected()}]
    });
    const r = await api('POST', '/api/scan-projects');
    if (m.closed) return;
    if (!r.ok) { body.replaceChildren(callout('bad', t('scan.fail'), errorText(r))); return; }
    const items = arr(r.items);
    if (!items.length) {
      body.replaceChildren(emptyState({
        small: true, icon: 'folder-search', title: t('scan.none'),
        text: t('scan.noneText'),
        actions: [btn(t('scan.openSettings'), {icon: 'sliders', onClick: () => { m.close(); goPage('settings'); }})]
      }));
      return;
    }
    const addBtn = m.button('add');
    const countLabel = h('span', {class: 'muted small', 'aria-live': 'polite'});
    const allBox = h('input', {type: 'checkbox', 'aria-label': t('scan.selectAll')});
    const filter = h('input', {class: 'input input-sm', type: 'search', placeholder: t('scan.filterPh'), 'aria-label': t('scan.filterAria'), autocomplete: 'off'});
    const msgArea = h('div');
    const updateCount = () => {
      const n = rows.filter((x) => x.cb.checked && !x.cb.disabled).length;
      countLabel.textContent = n ? tn('scan.chosen', n) : t('scan.noneChosen');
      addBtn.disabled = n === 0;
      const selectable = rows.filter((x) => !x.cb.disabled && !x.tr.hidden);
      allBox.checked = selectable.length > 0 && selectable.every((x) => x.cb.checked);
      allBox.indeterminate = !allBox.checked && selectable.some((x) => x.cb.checked);
    };
    rows = items.map((it) => {
      const info = it.info || {};
      const sugg = Array.isArray(it.suggestions) ? it.suggestions : arr(it.suggestions && it.suggestions.php);
      const added = !!it.alreadyAdded;
      const name = it.name || baseName(it.path);
      const cb = h('input', {type: 'checkbox', 'aria-label': t('scan.chooseAria', {name}), disabled: added});
      const sel = h('select', {class: 'select select-sm', 'aria-label': 'PHP: ' + name});
      fillPhpOptions(sel, sugg, null);
      sel.disabled = added || !okPhp().length;
      const lv = info.laravel || info.laravelLocked || info.laravelInstalled || (info.isLaravel ? info.laravelConstraint || '?' : null);
      const tr = h('tr', {class: added ? 'is-disabled' : null},
        h('td', {class: 'shrink'}, cb),
        h('td', null, h('div', {class: 'cell-strong'}, name), h('div', {class: 'cell-path'}, it.path)),
        h('td', null, lv ? chip('Laravel ' + lv, {cls: 'chip-ver chip-laravel'}) : chip(info.isLaravel === false ? t('proj.plainPhp') : '-', {})),
        h('td', {class: 'mono nowrap'}, info.composerPhp || '-'),
        h('td', null, sel),
        h('td', {class: 'shrink'}, added ? chip(t('scan.already'), {kind: 'ok', icon: 'check'}) : null));
      cb.addEventListener('change', updateCount);
      tr.addEventListener('click', (ev) => {
        if (ev.target.closest('select, input, button, a, label')) return;
        if (!cb.disabled) { cb.checked = !cb.checked; updateCount(); }
      });
      return {it, cb, sel, tr, name, dbServerId: it.suggestions && !Array.isArray(it.suggestions) ? it.suggestions.dbServerId || null : null};
    });
    allBox.addEventListener('change', () => {
      for (const x of rows) if (!x.cb.disabled && !x.tr.hidden) x.cb.checked = allBox.checked;
      updateCount();
    });
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const x of rows) x.tr.hidden = !!q && !(x.name.toLowerCase().includes(q) || String(x.it.path).toLowerCase().includes(q));
      updateCount();
    });
    const newCount = rows.filter((x) => !x.cb.disabled).length;
    body.replaceChildren(
      msgArea,
      h('div', {class: 'row'}, chip(tn('scan.found', items.length), {kind: 'info', icon: 'folder'}), chip(tn('scan.new', newCount), {kind: newCount ? 'accent' : null}),
        h('span', {class: 'spacer'}), h('div', {class: 'search'}, icon('search'), filter), countLabel),
      h('div', {class: 'table-wrap'}, h('table', {class: 'table'},
        h('thead', null, h('tr', null, h('th', {class: 'shrink'}, allBox), h('th', null, t('common.folder')), h('th', null, 'Laravel'),
          h('th', null, t('facts.phpReq')), h('th', null, t('scan.phpSuggest')), h('th', null, ''))),
        h('tbody', null, rows.map((x) => x.tr)))));
    updateCount();

    async function addSelected() {
      const chosen = rows.filter((x) => x.cb.checked && !x.cb.disabled);
      if (!chosen.length) return;
      const composerId = newestComposerId();
      const fails = [];
      let okCount = 0;
      await modalBusy(m, addBtn, t('scan.adding'), async () => {
        for (const x of chosen) {
          const rt = okPhp().find((r2) => r2.path === x.sel.value);
          if (!rt) { fails.push(t('scan.noPhp', {name: x.name})); continue; }
          const res = await api('POST', '/api/projects', {
            path: x.it.path, name: x.name, phpVersion: rt.version, phpPath: rt.path, composerId, dbServerId: x.dbServerId
          });
          if (res.ok) {
            okCount++;
            x.cb.checked = false;
            x.cb.disabled = true;
            x.sel.disabled = true;
            x.tr.classList.add('is-disabled');
          } else {
            fails.push(x.name + ': ' + errorText(res));
          }
        }
      });
      if (m.closed) return;
      updateCount();
      await refreshNow();
      if (okCount) toast('success', tn('scan.addedN', okCount));
      if (fails.length) {
        msgArea.replaceChildren(callout('bad', t('scan.someFailed'), h('ul', null, fails.map((f) => h('li', null, f)))));
      } else {
        m.close(true);
        if (S.page !== 'projects') goPage('projects');
      }
    }
  }

  /* ===================== DB Time Machine (restore points + undo) ===================== */
  function pointReasonChip(r) {
    const kind = r === 'manual' ? 'accent' : r === 'artisan' ? 'info' : r === 'pre-undo' ? 'warn' : null;
    return chip(hasT('tm.reason.' + r) ? t('tm.reason.' + r) : r, {kind});
  }
  async function openTimeMachine(p0, tab) {
    const pointsPane = h('div', {class: 'stack'}, h('div', {class: 'row muted'}, spinner(), t('common.loading')));
    const actionsPane = h('div', {class: 'stack'}, h('div', {class: 'row muted'}, spinner(), t('common.loading')));
    const tabs = h('div', {class: 'seg tm-tabs', role: 'tablist'});
    // explained once; afterwards it stays folded so the list gets the room (click to open again)
    const seen = lsGet('devpanel.tmWhatSeen') === '1';
    lsSet('devpanel.tmWhatSeen', '1');
    const what = h('details', {class: 'tm-what', open: !seen},
      h('summary', {class: 'tm-what-title'}, icon('info'), t('tm.whatTitle')),
      h('ol', {class: 'tm-what-list'},
        h('li', null, icon('list'), h('span', null, t('hist.what0'))),
        h('li', null, icon('layers'), h('span', null, t('tm.what1'))),
        h('li', null, icon('undo'), h('span', null, t('tm.what2'))),
        h('li', null, icon('shield'), h('span', null, t('tm.what3')))));
    const m = openModal({
      title: t('tm.title', {name: p0.name}), subtitle: t('tm.sub'), icon: 'undo', size: 'xl',
      body: h('div', {class: 'stack'}, what, tabs, actionsPane, pointsPane),
      actions: [{label: t('common.close'), value: null}]
    });
    const show = (which) => {
      actionsPane.hidden = which !== 'actions';
      pointsPane.hidden = which !== 'points';
      for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.tab === which));
    };
    for (const x of [{id: 'actions', icon: 'list', label: t('hist.tab')}, {id: 'points', icon: 'layers', label: t('tm.tabPoints')}]) {
      const b = h('button', {type: 'button', class: 'seg-btn', role: 'tab', dataset: {tab: x.id}}, icon(x.icon), x.label);
      b.addEventListener('click', () => show(x.id));
      tabs.appendChild(b);
    }
    show(tab === 'points' ? 'points' : 'actions');
    loadActions(p0, actionsPane, m, () => show('points'), null);
    const load = async () => {
      const r = await api('GET', '/api/projects/' + enc(p0.id) + '/points');
      if (m.closed) return;
      if (!r.ok) { pointsPane.replaceChildren(callout('bad', t('tm.loadFail'), errorText(r))); return; }
      const p = findProject(p0.id) || p0;
      const points = arr(r.points);
      const runJob = async (b, path, body, title, after) => {
        if (b) setBusy(b, true);
        const res = await api('POST', '/api/projects/' + enc(p.id) + path, body || {});
        if (b) setBusy(b, false);
        if (!res.ok || !res.jobId) return failToast(title, res);
        showJob(res.jobId, {title, icon: 'undo', closeOnDone: !!after, onFinal: async (job) => { await refreshNow(); if (!m.closed) load(); if (after && job.status === 'done') after(job); }});
      };
      const makeNow = btn(t('tm.makeNow'), {kind: 'primary', icon: 'layers', disabled: !p.dbServerId,
        onClick: (ev) => runJob(ev.currentTarget, '/restore-point', {reason: 'manual'}, t('tm.makeJob', {name: p.name}))});
      const rows = points.length ? h('div', {class: 'check-list'}, points.map((x, i) => {
        const meta = [
          x.tables != null ? tn('tm.tables', x.tables) : null,
          x.migrations != null ? tn('tm.migrations', x.migrations) : null,
          x.sizeBytes != null ? fmtBytes(x.sizeBytes) : null
        ].filter(Boolean).join(' · ');
        return h('div', {class: 'check-item bk-row'},
          h('span', {class: 'check-icon'}, icon(x.reason === 'pre-undo' ? 'undo' : 'layers')),
          h('span', {class: 'check-main grow'},
            h('span', {class: 'check-title row'}, fmtStamp(x.name), pointReasonChip(x.reason),
              i === 0 ? chip(t('tm.newest'), {kind: 'ok'}) : null,
              x.createdAt ? h('span', {class: 'muted small'}, agoText(x.createdAt)) : null),
            h('span', {class: 'check-desc'},
              x.command ? h('code', {class: 'ltr'}, x.command) : null, x.command ? ' · ' : null,
              h('span', {class: 'ltr'}, (x.database || '?') + (meta ? ' · ' + meta : '')))),
          btn(t('tm.undoHere'), {size: 'sm', icon: 'undo', disabled: !x.ok, onClick: async (ev) => {
            const b = ev.currentTarget;
            const yes = await confirmDialog({
              title: t('tm.undoQ'), icon: 'undo', tone: 'warn', size: 'md',
              message: t('tm.undoMsg', {db: x.database || '?', when: fmtStamp(x.name)}),
              details: h('div', {class: 'stack'},
                kvList([[t('common.database'), x.database, true], [t('tm.pointLabel'), x.name, true], x.command ? [t('tm.madeBefore'), x.command, true] : null]),
                callout('ok', t('tm.safeTitle'), t('tm.safeText'))),
              confirmLabel: t('tm.undoYes'), confirmIcon: 'undo'
            });
            if (yes) runJob(b, '/undo', {name: x.name, confirm: true}, t('tm.undoJob', {name: p.name}));
          }}),
          btn(t('tm.delete'), {size: 'sm', kind: 'ghost', iconOnly: true, icon: 'trash', onClick: async () => {
            const yes = await confirmDialog({title: t('tm.deleteQ'), danger: true, icon: 'trash', message: t('tm.deleteMsg', {when: fmtStamp(x.name)}), confirmLabel: t('remove.yes')});
            if (!yes) return;
            const res = await api('POST', '/api/projects/' + enc(p.id) + '/points/delete', {name: x.name, confirm: true});
            if (!res.ok) return failToast(t('tm.deleteFail'), res);
            toast('success', t('tm.deleted'));
            await refreshNow();
            load();
          }}));
      })) : emptyState({small: true, icon: 'undo', title: t('tm.noneTitle'), text: t('tm.noneText')});
      const set = r.settings || {};
      pointsPane.replaceChildren(h('div', {class: 'stack'},
        !p.dbServerId ? callout('warn', null, t('tm.needDb')) : null,
        h('div', {class: 'row'}, makeNow, h('span', {class: 'spacer'}),
          r.database ? chip(t('common.database') + ': ' + r.database, {mono: true, icon: 'db'}) : chip(t('tm.noEnvDb'), {kind: 'warn'})),
        callout('info', t('tm.howTitle'), set.beforeArtisan === false ? t('tm.howOff') : t('tm.how', {keep: set.keep || 20})),
        rows,
        h('p', {class: 'muted small mono'}, r.root || '')));
    };
    load();
  }

  /* ----- every action (binlog timeline) ----- */
  const OP_KIND = {INSERT: 'ok', UPDATE: 'info', DELETE: 'bad'};
  function colName(r, c) { return (r.columns && r.columns[c.col]) || ('@' + c.col); }
  function valText(c, full) {
    if (c.isNull) return 'NULL';
    if (c.value === '') return "''";
    const v = String(c.value);
    return !full && v.length > 60 ? v.slice(0, 57) + '…' : v;
  }
  /** One line per row change; an UPDATE shows only the columns that changed. */
  function rowSummary(r, full) {
    if (r.op === 'UPDATE') {
      const changed = r.after.filter((c) => {
        const b = r.before.find((x) => x.col === c.col);
        return !b || b.value !== c.value || b.isNull !== c.isNull;
      });
      const key = r.before[0] ? colName(r, r.before[0]) + '=' + valText(r.before[0], full) : '';
      return [key, ...changed.slice(0, full ? 40 : 4).map((c) => {
        const b = r.before.find((x) => x.col === c.col);
        return colName(r, c) + ': ' + (b ? valText(b, full) : '?') + ' → ' + valText(c, full);
      })].filter(Boolean).join(' · ');
    }
    const side = r.op === 'INSERT' ? r.after : r.before;
    const n = full ? 40 : 5;
    return side.slice(0, n).map((c) => colName(r, c) + '=' + valText(c, full)).join(' · ') + (side.length > n ? ' · …' : '');
  }
  /** "CREATE TABLE `x` (…" -> "CREATE TABLE x" */
  function ddlWhat(q) {
    const m = /^\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\s+(TABLE|VIEW|INDEX|DATABASE)?\s*(IF\s+(NOT\s+)?EXISTS\s+)?`?([^`\s(]+)/i.exec(String(q || ''));
    return m ? (m[1] + (m[2] ? ' ' + m[2] : '') + ' ' + m[5]).toUpperCase().replace(/ ([^ ]+)$/, (x, n) => ' ' + n.toLowerCase()) : '';
  }
  /** Short line under an action: the columns an UPDATE changed, or the record an INSERT / DELETE touched. */
  function colsSummary(a) {
    const rows = arr(a.rows);
    if (a.ddl) return [h('span', {class: 'muted small'}, t('hist.ddlShort'))];
    const out = [];
    const updated = new Set();
    const keys = [];
    for (const r of rows) {
      if (r.op === 'UPDATE') {
        for (const c of r.after) {
          const b = r.before.find((x) => x.col === c.col);
          if (!b || b.value !== c.value || b.isNull !== c.isNull) updated.add(colName(r, c));
        }
      }
      const k = (r.op === 'INSERT' ? r.after : r.before)[0];
      if (k && keys.length < 4) keys.push(colName(r, k) + '=' + valText(k));
    }
    if (keys.length) out.push(h('span', {class: 'hist-key ltr'}, keys.join(', ') + (a.rowCount > keys.length ? ' …' : '')));
    if (updated.size) {
      out.push(h('span', {class: 'muted small'}, t('hist.changedCols')));
      for (const c of [...updated].slice(0, 8)) out.push(h('span', {class: 'hist-col ltr'}, c));
      if (updated.size > 8) out.push(h('span', {class: 'muted small'}, '+' + (updated.size - 8)));
    } else if (rows.length) {
      out.push(h('span', {class: 'muted small'}, t(rows[0].op === 'DELETE' ? 'hist.wholeDeleted' : rows[0].op === 'INSERT' ? 'hist.wholeAdded' : 'hist.noChange')));
    }
    return out;
  }
  function rowLine(x, withTable, full) {
    return h('span', {class: 'hist-rowline ltr'}, h('span', {class: 'hist-op op-' + x.op.toLowerCase()}, x.op), ' ', withTable ? x.table + ': ' : '', rowSummary(x, full));
  }
  /** One action, compact: time, op, table, which record / columns; a click shows the SQL and all values. */
  function actionRow(a, onUndo) {
    const ops = a.ddl ? [chip(t('hist.ddlChip'), {})] : arr(a.ops).map((o) => chip(o, {kind: OP_KIND[o]}));
    const rows = arr(a.rows);
    const undo = a.canUndo ? btn(t('hist.undoThis'), {size: 'sm', icon: 'undo', onClick: (ev) => { ev.stopPropagation(); onUndo(a, ev.currentTarget); }}) : null;
    const details = h('span', {class: 'hist-details', hidden: true},
      a.query ? h('span', {class: 'hist-det-label'}, t('hist.sqlLabel')) : null,
      a.query ? h('pre', {class: 'hist-sql-full ltr'}, a.query) : null,
      rows.length ? h('span', {class: 'hist-det-label'}, t('hist.valuesLabel')) : null,
      rows.length ? h('span', {class: 'hist-rows'}, rows.map((x) => rowLine(x, true, true)),
        a.rowCount > rows.length ? h('span', {class: 'muted small'}, tn('hist.moreRows', a.rowCount - rows.length)) : null) : null,
      a.ddl ? h('span', {class: 'muted small'}, t('hist.ddlNote')) : null);
    const toggle = h('button', {type: 'button', class: 'hist-toggle', 'aria-expanded': 'false', title: t('hist.showDetails')},
      icon('chevron-right'), h('span', null, t('hist.details')));
    const main = h('span', {class: 'check-main grow'},
      h('span', {class: 'check-title row'}, h('span', {class: 'mono small'}, (a.time || '?').slice(11)), ...ops,
        h('b', {class: 'ltr'}, arr(a.tables).join(', ') || (a.ddl ? ddlWhat(a.query) : '')),
        a.rowCount > 1 ? h('span', {class: 'muted small'}, tn('hist.rows', a.rowCount)) : null,
        a.isUndo ? chip(t('hist.undoChip'), {kind: 'warn', icon: 'undo'}) : null),
      h('span', {class: 'hist-cols'}, ...colsSummary(a)),
      toggle, details);
    const row = h('div', {class: ['check-item', 'hist-row', a.isUndo && 'is-undo']},
      h('span', {class: 'check-icon'}, icon(a.ddl ? 'db' : a.isUndo ? 'undo' : 'list')), main, undo);
    const open = () => {
      const on = details.hidden;
      details.hidden = !on;
      toggle.setAttribute('aria-expanded', String(on));
      toggle.querySelector('span').textContent = on ? t('hist.hideDetails') : t('hist.details');
      row.classList.toggle('is-open', on);
    };
    toggle.addEventListener('click', (ev) => { ev.stopPropagation(); open(); });
    main.addEventListener('click', (ev) => { if (!ev.target.closest('pre, button, a') && !window.getSelection().toString()) open(); });
    return row;
  }
  /** Consecutive actions of the same kind on the same table(s) -> runs [{key, items}] (newest first). */
  function actionRuns(list) {
    const out = [];
    for (const a of list) {
      const key = a.ddl || a.isUndo ? null : arr(a.ops).join('+') + '|' + arr(a.tables).join(',');
      const last = out[out.length - 1];
      if (key && last && last.key === key) last.items.push(a);
      else out.push({key, items: [a]});
    }
    return out;
  }
  function dayLabel(d) {
    const p = (n) => String(n).padStart(2, '0');
    const fmt = (x) => x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
    const now = new Date();
    if (d === fmt(now)) return t('hist.today');
    if (d === fmt(new Date(now.getTime() - 86400000))) return t('hist.yesterday');
    return d;
  }
  /** A run of 3+ similar actions as one line ("events · INSERT × 250, 14:01–14:05"); a click lists them. */
  function runRow(run, onUndo) {
    const a0 = run.items[0];
    const last = run.items[run.items.length - 1];
    const box = h('div', {class: 'check-list hist-runlist', hidden: true});
    const toggle = h('button', {type: 'button', class: 'hist-toggle', 'aria-expanded': 'false'}, icon('chevron-right'), h('span', null, tn('hist.runShow', run.items.length)));
    let built = false;
    const open = () => {
      if (!built) { built = true; box.replaceChildren(...run.items.map((x) => actionRow(x, onUndo))); }
      const on = box.hidden;
      box.hidden = !on;
      toggle.setAttribute('aria-expanded', String(on));
      toggle.querySelector('span').textContent = on ? t('hist.hideDetails') : tn('hist.runShow', run.items.length);
    };
    toggle.addEventListener('click', (ev) => { ev.stopPropagation(); open(); });
    const rowsTotal = run.items.reduce((n, x) => n + (x.rowCount || 0), 0);
    const main = h('span', {class: 'check-main grow'},
      h('span', {class: 'check-title row'},
        h('span', {class: 'mono small'}, (last.time || '').slice(11, 16) + '–' + (a0.time || '').slice(11, 16)),
        ...arr(a0.ops).map((o) => chip(o + ' × ' + fmtInt(run.items.length), {kind: OP_KIND[o]})),
        h('b', {class: 'ltr'}, arr(a0.tables).join(', ')),
        rowsTotal > run.items.length ? h('span', {class: 'muted small'}, tn('hist.rows', rowsTotal)) : null),
      h('span', {class: 'hist-cols'}, h('span', {class: 'muted small'}, t('hist.runNote'))),
      toggle, box);
    main.addEventListener('click', (ev) => { if (!ev.target.closest('.hist-runlist, button, pre, a')) open(); });
    return h('div', {class: 'check-item hist-row hist-run'}, h('span', {class: 'check-icon'}, icon('layers')), main);
  }
  /** One hour of actions: header (time, count, per-op counts) + its rows; later hours start closed. */
  function hourGroup(key, items, onUndo, startOpen) {
    const counts = {};
    for (const a of items) for (const o of (a.ddl ? ['DDL'] : arr(a.ops))) counts[o] = (counts[o] || 0) + 1;
    const body = h('div', {class: 'check-list hist-list', hidden: !startOpen});
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      body.replaceChildren(...actionRuns(items).map((r) => (r.key && r.items.length >= 3 ? runRow(r, onUndo) : r.items.map((x) => actionRow(x, onUndo)))).flat());
    };
    if (startOpen) build();
    const head = h('button', {type: 'button', class: 'hist-hour', 'aria-expanded': String(!!startOpen)},
      icon('chevron-right'),
      h('b', null, dayLabel(key.slice(0, 10)) + '  ' + key.slice(11, 13) + ':00 – ' + key.slice(11, 13) + ':59'),
      h('span', {class: 'muted small'}, tn('hist.actions', items.length)),
      h('span', {class: 'spacer'}),
      ...['DELETE', 'UPDATE', 'INSERT', 'DDL'].filter((o) => counts[o]).map((o) => chip((o === 'DDL' ? t('hist.ddlChip') : o) + ' ' + fmtInt(counts[o]), {kind: OP_KIND[o]})));
    head.addEventListener('click', () => {
      build();
      body.hidden = !body.hidden;
      head.setAttribute('aria-expanded', String(!body.hidden));
    });
    return h('section', {class: 'hist-group'}, head, body);
  }
  async function loadActions(p0, pane, m, gotoPoints, state) {
    const st = Object.assign({table: null, op: null, q: '', limit: 100}, state || {});
    pane.replaceChildren(h('div', {class: 'row muted'}, spinner(), t('hist.loading')));
    const qs = '?limit=' + st.limit + (st.table ? '&table=' + enc(st.table) : '') + (st.op ? '&op=' + enc(st.op) : '') + (st.q ? '&q=' + enc(st.q) : '');
    const r = await api('GET', '/api/projects/' + enc(p0.id) + '/history' + qs);
    if (m.closed) return;
    const p = findProject(p0.id) || p0;
    const reload = (patch) => loadActions(p0, pane, m, gotoPoints, Object.assign({}, st, patch || {}));
    if (!r.ok) {
      pane.replaceChildren(callout('warn', t('hist.unavailable'), errorText(r), [btn(t('tm.tabPoints'), {size: 'sm', icon: 'layers', onClick: gotoPoints})]));
      return;
    }
    if (r.busy) {
      pane.replaceChildren(callout('warn', t('hist.busyTitle'), t('hist.busyText'), [btn(t('hist.refresh'), {size: 'sm', icon: 'refresh', onClick: () => reload()})]));
      return;
    }
    if (!r.on) {
      const can = r.reason !== 'UNSUPPORTED';
      const enable = btn(t('hist.enableBtn'), {kind: 'primary', size: 'sm', icon: 'power', onClick: async (ev) => {
        const b = ev.currentTarget;
        const yes = await confirmDialog({
          title: t('hist.enableQ'), icon: 'power', tone: 'warn', size: 'md',
          message: t('hist.enableMsg', {label: (r.server && r.server.label) || '?'}),
          details: callout('info', null, t('hist.enableNote')), confirmLabel: t('hist.enableYes'), confirmIcon: 'power'
        });
        if (!yes) return;
        setBusy(b, true);
        const res = await api('POST', '/api/projects/' + enc(p.id) + '/history/enable', {confirm: true});
        setBusy(b, false);
        if (!res.ok || !res.jobId) return failToast(t('hist.enableFail'), res);
        showJob(res.jobId, {title: t('hist.enableQ'), icon: 'power', closeOnDone: true, onFinal: async () => { await refreshNow(); if (!m.closed) reload(); }});
      }});
      pane.replaceChildren(callout(can ? 'info' : 'warn', t('hist.offTitle'), t(can ? 'hist.offText' : 'hist.unsupportedText'), can ? [enable] : null));
      return;
    }
    // ---- toolbar: what is in the window (counts double as filters), table, search, refresh
    const stats = r.stats || {};
    const opChip = (op, label, n) => {
      const b = h('button', {type: 'button', class: ['seg-btn', 'hist-op-filter'], 'aria-pressed': String(st.op === op)},
        label, h('span', {class: 'seg-count'}, fmtInt(n || 0)));
      b.addEventListener('click', () => reload({op: st.op === op ? null : op, limit: 100}));
      return b;
    };
    const ops = h('div', {class: 'seg hist-ops', role: 'group', 'aria-label': t('hist.opsAria')},
      opChip(null, t('hist.all'), stats.total),
      opChip('DELETE', 'DELETE', stats.DELETE), opChip('UPDATE', 'UPDATE', stats.UPDATE),
      opChip('INSERT', 'INSERT', stats.INSERT), opChip('DDL', t('hist.ddlChip'), stats.DDL));
    const filter = h('select', {class: 'select select-sm hist-filter', 'aria-label': t('hist.filterAria')},
      h('option', {value: ''}, t('hist.allTables')), arr(r.tables).map((x) => h('option', {value: x}, x)));
    filter.value = st.table || '';
    filter.addEventListener('change', () => reload({table: filter.value || null, limit: 100}));
    const search = h('input', {class: 'input input-sm hist-search', type: 'search', placeholder: t('hist.searchPh'), value: st.q || '', 'aria-label': t('hist.searchPh'), autocomplete: 'off', spellcheck: 'false'});
    const go = debounce(() => reload({q: search.value.trim(), limit: 100}), 500);
    search.addEventListener('input', go);
    search.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { go.cancel(); reload({q: search.value.trim(), limit: 100}); } });
    const head = h('div', {class: 'stack hist-toolbar'},
      h('div', {class: 'row'},
        chip(t('hist.liveOn'), {kind: 'ok', dot: 'dot-ok pulse'}),
        chip(t('common.database') + ': ' + r.database, {mono: true, icon: 'db'}),
        stats.from ? h('span', {class: 'muted small'}, t('hist.window', {from: stats.from.slice(5, 16), to: stats.to.slice(5, 16)})) : null,
        h('span', {class: 'spacer'}),
        btn(t('hist.refresh'), {size: 'sm', icon: 'refresh', onClick: () => reload()})),
      h('div', {class: 'row'}, ops, h('span', {class: 'spacer'}), h('div', {class: 'search'}, icon('search'), search), filter));
    const actions = arr(r.actions);
    const filtered = !!(st.op || st.table || st.q);
    if (!actions.length) {
      pane.replaceChildren(head, emptyState({small: true, icon: filtered ? 'search' : 'list', title: t(filtered ? 'hist.noMatch' : 'hist.noneTitle'), text: t(filtered ? 'hist.noMatchText' : 'hist.noneText')}));
      return;
    }
    const onUndo = (a, b) => undoAction(p, a, b, m, () => reload());
    // ---- groups per hour (newest first); the first two hours are open
    const groups = [];
    for (const a of actions) {
      const key = (a.time || '????-??-?? ??').slice(0, 13);
      const g = groups[groups.length - 1];
      if (g && g.key === key) g.items.push(a); else groups.push({key, items: [a]});
    }
    const list = h('div', {class: 'hist-groups'}, groups.map((g, i) => hourGroup(g.key, g.items, onUndo, i < 2)));
    const more = r.more ? btn(t('hist.loadMore', {n: 100}), {icon: 'chevron-down', onClick: () => reload({limit: st.limit + 100})}) : null;
    pane.replaceChildren(...[head,
      h('p', {class: 'muted small'}, t('hist.showing', {n: fmtInt(actions.length), total: fmtInt(r.matchedCount || actions.length)})),
      list, more].filter(Boolean));
    if (st.q) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }
  async function undoAction(p, a, b, m, reload) {
    setBusy(b, true);
    const chk = await api('POST', '/api/projects/' + enc(p.id) + '/history/check', {id: a.id});
    setBusy(b, false);
    if (!chk.ok) return failToast(t('hist.undoFail'), chk);
    const conflicts = arr(chk.conflicts);
    const yes = await confirmDialog({
      title: t('hist.undoQ'), icon: 'undo', tone: conflicts.length ? 'bad' : 'warn', size: 'md',
      message: arr(a.ops).map((o) => t('hist.effect.' + o)).join(' '),
      details: h('div', {class: 'stack'},
        h('div', {class: 'hist-rows'}, arr(a.rows).slice(0, 5).map((x) => rowLine(x, true))),
        conflicts.length ? callout('bad', t('hist.conflictTitle'), h('ul', null, conflicts.slice(0, 6).map((c) => h('li', {class: 'ltr'}, c.time + ' · ' + c.op + ' ' + c.table + ' (' + c.key + ')')))) : null,
        callout('ok', null, t('hist.undoSafe'))),
      confirmLabel: t('hist.undoYes'), confirmIcon: 'undo'
    });
    if (!yes) return;
    setBusy(b, true);
    const res = await api('POST', '/api/projects/' + enc(p.id) + '/history/undo', {id: a.id, confirm: true});
    setBusy(b, false);
    if (!res.ok || !res.jobId) return failToast(t('hist.undoFail'), res);
    showJob(res.jobId, {title: t('hist.undoQ'), icon: 'undo', closeOnDone: true, onFinal: async () => { await refreshNow(); if (!m.closed) reload(); }});
  }

  /* ===================== Live share link (Cloudflare quick tunnel) ===================== */
  async function installCloudflared(after) {
    const cat = await api('GET', '/api/installer/catalog?kind=cloudflared');
    if (!cat.ok || !arr(cat.items).length) return failToast(t('share.catFail'), cat);
    const it = cat.items[0];
    const yes = await confirmDialog({
      title: t('share.installQ'), icon: 'download', size: 'md',
      message: t('share.installMsg', {version: it.version, size: it.sizeMB ? Math.round(it.sizeMB) + ' MB' : '?'}),
      details: kvList([[t('in.source'), it.url, true], ['SHA-256', it.sha256 ? String(it.sha256).slice(0, 24) + '…' : '-', true]]),
      confirmLabel: t('share.installYes'), confirmIcon: 'download'
    });
    if (!yes) return;
    const r = await api('POST', '/api/installer/install', {kind: 'cloudflared', version: it.version, confirm: true});
    if (!r.ok || !r.jobId) return failToast(t('share.installFail'), r);
    showJob(r.jobId, {title: t('share.installJob'), icon: 'download', closeOnDone: true, progress: (job) => jobProgress(job, true),
      onFinal: async (job) => { await refreshNow(); if (job.status === 'done' && after) after(); }});
  }
  function shareStrip(p) {
    const sh = p.share;
    if (!sh || !safeUrl(sh.url)) return null;
    const link = h('a', {class: 'run-url share-url', href: sh.url, target: '_blank', rel: 'noopener noreferrer', title: t('share.openTitle')},
      icon('globe'), h('span', {class: 'ltr'}, sh.url));
    link.addEventListener('click', (ev) => {
      if (ev.button !== 0 || ev.ctrlKey || ev.shiftKey || ev.metaKey || ev.altKey) return;
      ev.preventDefault();
      api('POST', '/api/open-share', {url: sh.url}).then((r) => { if (!r.ok) window.open(sh.url, '_blank', 'noopener'); });
    });
    return h('div', {class: 'run-strip share-strip'},
      chip(t('share.live'), {kind: 'ok', dot: 'dot-ok pulse', cls: 'share-live'}),
      link, copyButton(sh.url, t('share.copy')),
      h('span', {class: 'run-meta', dataset: {since: sh.startedAt, tpl: 'proj.runningFor'}}, t('proj.runningFor', {d: sinceText(sh.startedAt)})),
      btn(t('share.stop'), {size: 'sm', kind: 'soft-danger', icon: 'stop', onClick: (ev) => stopShare(p, ev.currentTarget)}));
  }
  async function stopShare(p, b) {
    setBusy(b, true);
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/share/stop');
    setBusy(b, false);
    if (!r.ok) return failToast(t('share.stopFail'), r);
    toast('success', t('share.stopped'), p.name);
    await refreshNow();
  }
  async function openShare(p0) {
    const p = findProject(p0.id) || p0;
    if (p.share && p.share.url) return showShareResult(p, {url: p.share.url, warnings: []});
    if (!(S.state.tools && S.state.tools.cloudflared)) {
      const yes = await confirmDialog({
        title: t('share.title'), icon: 'share', size: 'md', message: t('share.needTool'),
        details: callout('info', null, t('share.toolWhy')), confirmLabel: t('share.installYes'), confirmIcon: 'download'
      });
      if (yes) installCloudflared(() => openShare(p));
      return;
    }
    if (p.status !== 'running') {
      const yes = await confirmDialog({title: t('share.title'), icon: 'share', size: 'sm', message: t('share.startFirst', {name: p.name}), confirmLabel: t('share.startAndShare'), confirmIcon: 'play'});
      if (!yes) return;
      await startProject(p);
      const fresh = findProject(p.id);
      if (!fresh || fresh.status !== 'running') return;
      return openShare(fresh);
    }
    const yes = await confirmDialog({
      title: t('share.q', {name: p.name}), icon: 'share', tone: 'warn', size: 'md', message: t('share.warnMsg'),
      details: h('ul', {class: 'bullets'}, h('li', null, t('share.warn1')), h('li', null, t('share.warn2')), h('li', null, t('share.warn3'))),
      confirmLabel: t('share.yes'), confirmIcon: 'share'
    });
    if (!yes) return;
    const m = openModal({
      title: t('share.title'), subtitle: p.name, icon: 'share', size: 'md', dismissible: false,
      body: h('div', {class: 'stack'}, h('div', {class: 'row'}, spinner(), t('share.making')), h('p', {class: 'muted small'}, t('share.makingHint')))
    });
    S.pending[p.id] = 'starting';
    renderAll();
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/share/start', {confirm: true});
    delete S.pending[p.id];
    await refreshNow();
    m.close();
    if (!r.ok) {
      const tail = typeof r.logTail === 'string' ? r.logTail : '';
      openModal({
        title: t('share.fail'), subtitle: p.name, icon: 'alert-circle', tone: 'bad', size: 'lg',
        body: [callout('bad', null, errorText(r)), tail ? h('pre', {class: 'term-mini', dir: 'ltr'}, tail) : null],
        actions: [{label: t('common.ok'), kind: 'primary', value: null, autofocus: true}]
      });
      return;
    }
    showShareResult(findProject(p.id) || p, r);
  }
  function showShareResult(p, r) {
    const url = safeUrl(r.url);
    if (!url) return;
    const warns = arr(r.warnings);
    openModal({
      title: t('share.ready'), subtitle: p.name, icon: 'share', tone: 'ok', size: 'md',
      body: h('div', {class: 'stack'},
        h('div', {class: 'share-big'}, h('code', {class: 'ltr break'}, url), copyButton(url, t('share.copy'))),
        h('p', {class: 'muted'}, t('share.readyText')),
        warns.includes('VITE_HOT') ? callout('warn', t('share.viteTitle'), t('share.viteText')) : null,
        warns.includes('NO_HTTPS_FIX') ? callout('warn', null, t('share.noHttpsFix')) : null,
        callout('info', null, t('share.endsWith'))),
      actions: [
        {label: t('share.stop'), kind: 'soft-danger', icon: 'stop', left: true, onClick: async (m, b) => { await stopShare(p, b); m.close(); }},
        {label: t('share.copy'), icon: 'copy', onClick: async () => { if (await copyText(url)) toast('success', t('copy.done'), url); }},
        {label: t('share.open'), kind: 'primary', icon: 'external', onClick: () => api('POST', '/api/open-share', {url}).then((x) => { if (!x.ok) window.open(url, '_blank', 'noopener'); })}
      ]
    });
  }

  /* ===================== Shift from XAMPP / Laragon / WAMP ===================== */
  async function openImport() {
    const body = h('div', {class: 'stack'}, h('div', {class: 'row muted'}, spinner(), t('imp.searching')));
    const m = openModal({
      title: t('imp.title'), subtitle: t('imp.sub'), icon: 'import', size: 'xl', body,
      actions: [{label: t('common.close'), value: null}, {id: 'add', label: t('imp.shift'), kind: 'primary', icon: 'import', disabled: true, onClick: () => shiftSelected()}]
    });
    const r = await api('GET', '/api/import/plan');
    if (m.closed) return;
    if (!r.ok) { body.replaceChildren(callout('bad', t('imp.fail'), errorText(r))); return; }
    const stacks = arr(r.stacks);
    const withProjects = stacks.filter((s) => arr(s.projects).length);
    if (!withProjects.length) {
      body.replaceChildren(emptyState({
        small: true, icon: 'import', title: stacks.length ? t('imp.noProjects') : t('imp.noStacks'),
        text: t('imp.noneText'),
        actions: [btn(t('scan.openSettings'), {icon: 'sliders', onClick: () => { m.close(); goPage('settings'); }})]
      }));
      return;
    }
    const addBtn = m.button('add');
    const countLabel = h('span', {class: 'muted small', 'aria-live': 'polite'});
    const msgArea = h('div');
    const rows = [];
    const updateCount = () => {
      const n = rows.filter((x) => x.cb.checked && !x.cb.disabled).length;
      countLabel.textContent = n ? tn('imp.chosen', n) : t('scan.noneChosen');
      addBtn.disabled = n === 0;
    };
    const sections = withProjects.map((s) => {
      const stackRows = arr(s.projects).map((it) => {
        const added = !!it.alreadyAdded;
        const cb = h('input', {type: 'checkbox', 'aria-label': t('scan.chooseAria', {name: it.name}), disabled: added, checked: !added});
        const sel = h('select', {class: 'select select-sm', 'aria-label': 'PHP: ' + it.name});
        fillPhpOptions(sel, it.php ? [{version: it.php.version, path: it.php.path, satisfies: true, hint: null}] : [], it.php ? it.php.path : null);
        sel.disabled = added || !okPhp().length;
        const dbSel = h('select', {class: 'select select-sm', 'aria-label': t('field.db') + ': ' + it.name});
        fillDbOptions(dbSel, it.dbServerId);
        dbSel.disabled = added;
        const tr = h('tr', {class: added ? 'is-disabled' : null},
          h('td', {class: 'shrink'}, cb),
          h('td', null, h('div', {class: 'cell-strong'}, it.name), h('div', {class: 'cell-path'}, it.path)),
          h('td', null, it.domains.length ? h('div', {class: 'row'}, it.domains.slice(0, 2).map((d) => chip(d, {mono: true, icon: 'globe'}))) : chip(it.from === 'vhost' ? 'vhost' : it.from, {})),
          h('td', null, it.laravel ? chip('Laravel ' + it.laravel, {cls: 'chip-ver chip-laravel'}) : chip(t('proj.plainPhp'), {})),
          h('td', null, sel, it.php && it.php.same ? h('div', {class: 'field-hint'}, t('imp.samePhp')) : null),
          h('td', null, dbSel),
          h('td', {class: 'shrink'}, added ? chip(t('scan.already'), {kind: 'ok', icon: 'check'}) : null));
        cb.addEventListener('change', updateCount);
        tr.addEventListener('click', (ev) => {
          if (ev.target.closest('select, input, button, a, label')) return;
          if (!cb.disabled) { cb.checked = !cb.checked; updateCount(); }
        });
        const row = {it, cb, sel, dbSel, tr, composerId: it.composerId || null};
        rows.push(row);
        return row;
      });
      const dbText = arr(s.db).map((d) => dbKindLabel(d.kind) + ' ' + (d.version || '') + ' :' + d.port).join(', ');
      return h('section', {class: 'imp-stack'},
        h('h3', {class: 'wiz-h'}, icon(s.kind === 'Laragon' ? 'layers' : 'server'), s.kind, h('span', {class: 'muted small mono'}, s.root)),
        h('div', {class: 'row'},
          s.php ? chip('PHP ' + s.php.version, {fam: famClass(s.php.version)}) : null,
          dbText ? chip(dbText, {icon: 'db'}) : chip(t('imp.noDb'), {kind: 'warn'}),
          chip(tn('imp.count', stackRows.length), {kind: 'info'})),
        h('div', {class: 'table-wrap'}, h('table', {class: 'table'},
          h('thead', null, h('tr', null, h('th', {class: 'shrink'}, ''), h('th', null, t('common.folder')), h('th', null, t('imp.wasAt')), h('th', null, 'Laravel'),
            h('th', null, 'PHP'), h('th', null, t('field.db')), h('th', null, ''))),
          h('tbody', null, stackRows.map((x) => x.tr)))));
    });
    body.replaceChildren(
      msgArea,
      callout('ok', t('imp.safeTitle'), t('imp.safeText')),
      h('div', {class: 'row'}, h('span', {class: 'spacer'}), countLabel),
      ...sections);
    updateCount();

    async function shiftSelected() {
      const chosen = rows.filter((x) => x.cb.checked && !x.cb.disabled);
      if (!chosen.length) return;
      const fails = [];
      let okCount = 0;
      let firstId = null;
      await modalBusy(m, addBtn, t('imp.shifting'), async () => {
        for (const x of chosen) {
          const rt = okPhp().find((r2) => r2.path === x.sel.value);
          if (!rt) { fails.push(t('scan.noPhp', {name: x.it.name})); continue; }
          const res = await api('POST', '/api/projects', {
            path: x.it.path, name: x.it.name, phpVersion: rt.version, phpPath: rt.path,
            composerId: x.composerId || newestComposerId(), dbServerId: x.dbSel.value || null
          });
          if (res.ok) {
            okCount++;
            if (!firstId && res.project) firstId = res.project.id;
            x.cb.checked = false; x.cb.disabled = true; x.sel.disabled = true; x.dbSel.disabled = true;
            x.tr.classList.add('is-disabled');
          } else fails.push(x.it.name + ': ' + errorText(res));
        }
      });
      if (m.closed) return;
      updateCount();
      await refreshNow();
      if (okCount) toast('success', tn('imp.done', okCount), t('imp.doneText'), {duration: 8000});
      if (fails.length) msgArea.replaceChildren(callout('bad', t('scan.someFailed'), h('ul', null, fails.map((f) => h('li', null, f)))));
      else {
        m.close(true);
        if (firstId) S.flash = firstId;
        if (S.page !== 'projects') goPage('projects');
      }
    }
  }

  /* ===================== phpstation.json (team file) ===================== */
  const TEAM_STEP_ICON = {env: 'file', 'composer-install': 'package', key: 'key', database: 'db', migrate: 'layers', seed: 'sparkle', 'storage-link': 'link'};
  async function pickTeamFolder() {
    const r = await api('POST', '/api/pick-folder', {});
    if (!r.ok) return failToast(t('np.pickFail'), r);
    if (r.path) openTeamPlan(r.path);
  }
  async function openTeamPlan(path, o) {
    const opt = o || {};
    const m = openModal({
      title: opt.implicit ? t('clone.planTitle') : t('team.title'), subtitle: path, icon: 'users', size: 'lg',
      body: h('div', {class: 'row muted'}, spinner(), t('team.reading')),
      actions: [{label: t('common.close'), value: null}]
    });
    const r = await api('POST', '/api/teamfile/plan', {path, implicit: !!opt.implicit});
    if (m.closed) return;
    if (!r.ok) { m.body.replaceChildren(callout('bad', t('team.readFail'), errorText(r))); return; }
    const row = (iconName, title, state, text) => h('div', {class: 'check-item'},
      h('span', {class: ['check-icon', 'is-' + state]}, icon(state === 'ok' ? 'check-circle' : state === 'install' ? 'download' : state === 'bad' ? 'alert-circle' : 'alert')),
      h('span', {class: 'check-main grow'}, h('span', {class: 'check-title row'}, icon(iconName), title), text ? h('span', {class: 'check-desc'}, text) : null));
    const items = [];
    const php = r.php || {};
    if (php.have) items.push(row('code', t('team.phpWant', {v: php.want}), 'ok', t('team.have', {what: 'PHP ' + php.have.version})));
    else if (php.install) items.push(row('code', t('team.phpWant', {v: php.want}), 'install', t('team.willInstall', {what: 'PHP ' + php.install.version, size: php.install.sizeMB ? Math.round(php.install.sizeMB) + ' MB' : '?'})));
    else items.push(row('code', 'PHP', 'warn', t('team.phpUnknown')));
    for (const e of arr(r.extensions)) {
      const st = e.state === 'ok' ? 'ok' : e.state === 'enable' || e.state === 'later' ? 'install' : 'warn';
      items.push(row('package', 'ext-' + e.name, st, t('team.ext.' + e.state)));
    }
    if (r.db) {
      const want = (r.db.want.engine === 'mysql' ? 'MySQL' : 'MariaDB') + (r.db.want.version ? ' ' + r.db.want.version : '');
      if (r.db.install) items.push(row('db', want, 'install', t('team.willInstall', {what: 'MariaDB ' + r.db.install.version, size: r.db.install.sizeMB ? Math.round(r.db.install.sizeMB) + ' MB' : '?'}) + ' · ' + t('team.newServer')));
      else if (r.db.have) items.push(row('db', want, 'ok', t('team.have', {what: r.db.have.label + ' :' + r.db.have.port})));
      else items.push(row('db', want, 'warn', t('team.noDb')));
      if (r.db.want.name) items.push(row('db', t('common.database') + ': ' + r.db.want.name, 'ok', t('team.dbName')));
    }
    const comp = r.composer || {};
    if (comp.install) items.push(row('package', 'Composer', 'install', t('team.willInstall', {what: 'Composer ' + comp.install.version, size: '3 MB'})));
    else if (comp.have) items.push(row('package', 'Composer', 'ok', t('team.have', {what: 'Composer ' + comp.have.version})));
    const steps = arr(r.steps);
    const notes = arr(r.notes).map((n) => callout(n.level === 'bad' ? 'bad' : 'warn', null, t(n.key, n.params || {})));
    const errs = arr(r.errors);
    const blocked = !php.have && !php.install;
    const goBtnLabel = arr(r.installs).length ? t('team.goInstall', {n: arr(r.installs).length}) : t('team.go');
    m.body.replaceChildren(h('div', {class: 'stack'},
      h('div', {class: 'row'}, h('h3', {class: 'wiz-h'}, icon('users'), r.name), r.isLaravel ? chip('Laravel', {cls: 'chip-ver chip-laravel'}) : null,
        r.alreadyAdded ? chip(t('scan.already'), {kind: 'ok', icon: 'check'}) : chip(t('team.newProject'), {kind: 'accent'})),
      errs.length ? callout('warn', t('team.fileErrors'), errs.join(', ')) : null,
      ...notes,
      h('div', {class: 'check-list'}, items),
      steps.length ? h('div', null, h('h4', {class: 'wiz-h'}, icon('list'), t('team.steps')),
        h('ol', {class: 'team-steps'}, steps.map((s) => h('li', null, icon(TEAM_STEP_ICON[s] || 'dot'), t('team.stepL.' + s))))) : null,
      opt.implicit && !r.implicit ? null : opt.implicit ? callout('info', null, t('clone.planNote')) : null,
      callout('info', null, t('team.safe'))));
    m.setActions([
      {label: t('common.close'), value: null},
      {id: 'go', label: goBtnLabel, kind: 'primary', icon: 'bolt', disabled: blocked, onClick: async (mm, b) => {
        const res = await modalBusy(mm, b, t('team.starting'), () => api('POST', '/api/teamfile/apply', {path, confirm: true, implicit: !!opt.implicit}));
        if (!res.ok || !res.jobId) return failToast(t('team.applyFail'), res);
        mm.close();
        showJob(res.jobId, {
          title: t('team.jobTitle', {name: r.name}), icon: 'users', progress: (job) => jobProgress(job, true),
          onFinal: async (job) => {
            await refreshNow();
            if (job.status !== 'done' || !job.result) return;
            S.flash = job.result.projectId;
            if (S.page !== 'projects') goPage('projects');
            const fresh = findProject(job.result.projectId);
            if (fresh && opt.autoStart) { toast('success', t('team.readyToast', {name: fresh.name}), t('clone.starting2')); startProject(findProject(fresh.id) || fresh); }
            else if (fresh) toast('success', t('team.readyToast', {name: fresh.name}), null, {duration: 9000, actions: [{label: t('team.startNow'), onClick: () => startProject(findProject(fresh.id) || fresh)}]});
          }
        });
      }}
    ]);
  }
  async function openTeamExport(p) {
    const r = await api('GET', '/api/projects/' + enc(p.id) + '/teamfile');
    if (!r.ok) return failToast(t('team.readFail'), r);
    const json = JSON.stringify(r.proposed || {}, null, 2);
    openModal({
      title: t('team.exportTitle'), subtitle: p.name, icon: 'users', size: 'lg',
      body: h('div', {class: 'stack'},
        h('p', null, t('team.exportText')),
        r.exists ? callout('warn', t('team.existsTitle'), t('team.existsText')) : null,
        h('div', {class: 'field'}, h('span', {class: 'field-label row'}, h('code', {class: 'ltr'}, 'phpstation.json'), copyButton(json)),
          h('pre', {class: 'term-mini', dir: 'ltr'}, json)),
        callout('info', null, t('team.commitHint'))),
      actions: [
        {label: t('common.cancel'), value: null},
        {label: r.exists ? t('team.overwrite') : t('team.write'), kind: 'primary', icon: 'check', onClick: async (m, b) => {
          const res = await modalBusy(m, b, t('common.saving'), () => api('POST', '/api/projects/' + enc(p.id) + '/teamfile', {overwrite: !!r.exists}));
          if (!res.ok) return failToast(t('team.writeFail'), res);
          m.close();
          toast('success', t('team.written'), res.path + (res.backup ? '\n' + t('team.backupAt', {path: res.backup}) : ''), {duration: 8000});
        }}
      ]
    });
  }

  /* ===================== Inbox page (mail, dumps, errors) ===================== */
  const IB = {tab: 'mail', project: '', mailSel: null, mailQ: '', errLevel: 'errors', errQ: '', open: new Set(), dataSig: null, mounted: false};
  (function () {
    const tab = lsGet('devpanel.inboxTab');
    if (tab === 'mail' || tab === 'dumps' || tab === 'errors') IB.tab = tab;
  })();
  pageImpl.inbox = {mount: mountInbox, update: updateInbox, unmount() { IB.mounted = false; IB.ui = null; }};

  const EDITOR_LABEL = {vscode: 'VS Code', cursor: 'Cursor', phpstorm: 'PhpStorm', sublime: 'Sublime Text'};
  /** vscode://file/D:/app/X.php:12 and friends (null when links are off). */
  function editorUrl(file, line) {
    const ed = (S.state && S.state.settings && S.state.settings.editor) || 'vscode';
    if (!file || ed === 'none') return null;
    const f = String(file).replace(/\\/g, '/');
    const ln = Number(line) > 0 ? Number(line) : 1;
    if (ed === 'vscode' || ed === 'cursor') return ed + '://file/' + encodeURI(f).replace(/#/g, '%23').replace(/\?/g, '%3F') + ':' + ln;
    if (ed === 'phpstorm') return 'phpstorm://open?file=' + encodeURIComponent(String(file)) + '&line=' + ln;
    if (ed === 'sublime') return 'subl://open?url=' + encodeURIComponent('file://' + f) + '&line=' + ln;
    return null;
  }
  function projectRoot(id) { const p = id ? findProject(id) : null; return p ? p.path : null; }
  function shortPath(file, root) {
    const f = String(file || '');
    const r = String(root || '').replace(/[\\/]+$/, '');
    if (r && normPath(f).startsWith(normPath(r) + '\\')) return f.slice(r.length + 1);
    return f;
  }
  function fileLink(file, line, root) {
    if (!file) return null;
    const text = shortPath(file, root) + (line ? ':' + line : '');
    const url = editorUrl(file, line);
    return url
      ? h('a', {class: 'ib-file', href: url, title: t('ib.openEditor', {editor: EDITOR_LABEL[S.state.settings.editor || 'vscode'] || ''}) + '\n' + file, dir: 'ltr'}, icon('code'), h('span', null, text))
      : h('span', {class: 'ib-file', title: file, dir: 'ltr'}, icon('file'), h('span', null, text));
  }
  function projectChip(id) {
    const p = id ? findProject(id) : null;
    return p ? chip(p.name, {cls: 'ib-proj-chip', icon: 'grid', title: p.path}) : null;
  }
  function agoEl(at, cls) {
    return at ? h('span', {class: cls || 'ib-time', dataset: {since: at, mode: 'ago'}, title: new Date(parseTime(at)).toLocaleString()}, agoText(at)) : null;
  }

  /** Opens the Inbox on a tab (optionally filtered to a project / with a mail selected). */
  function openInbox(tab, projectId, mailId) {
    IB.tab = tab;
    lsSet('devpanel.inboxTab', tab);
    if (projectId !== undefined) IB.project = projectId || '';
    if (mailId) IB.mailSel = mailId;
    IB.dataSig = null;
    if (S.page === 'inbox' && IB.mounted) inboxTab(tab);
    else goPage('inbox');
  }

  function editorMenuItems() {
    const cur = (S.state && S.state.settings.editor) || 'vscode';
    const set = async (ed) => {
      const r = await api('POST', '/api/settings', {editor: ed});
      if (!r.ok) return failToast(t('ib.saveFail'), r);
      await refreshNow();
      IB.dataSig = null;
      if (IB.mounted) inboxLoad(true);
    };
    return [{heading: t('ib.editorHead')}]
      .concat(['vscode', 'cursor', 'phpstorm', 'sublime'].map((ed) => ({label: EDITOR_LABEL[ed], checked: cur === ed, onClick: () => set(ed)})))
      .concat([{label: t('ib.editorNone'), checked: cur === 'none', onClick: () => set('none')}]);
  }

  function mountInbox(root) {
    IB.mounted = true;
    IB.ui = {};
    const tabs = h('div', {class: 'seg ib-tabs', role: 'tablist', 'aria-label': t('ib.tabsAria')});
    IB.ui.tabs = {};
    for (const x of [{id: 'mail', icon: 'mail'}, {id: 'dumps', icon: 'code'}, {id: 'errors', icon: 'bug'}]) {
      const count = h('span', {class: 'seg-count ib-count'});
      const b = h('button', {type: 'button', class: 'seg-btn', role: 'tab', dataset: {tab: x.id}}, icon(x.icon), h('span', null, t('ib.tab.' + x.id)), count);
      b.addEventListener('click', () => inboxTab(x.id));
      IB.ui.tabs[x.id] = {btn: b, count};
      tabs.appendChild(b);
    }
    IB.ui.proj = h('select', {class: 'input ib-proj-select', 'aria-label': t('ib.projectAria')});
    IB.ui.proj.addEventListener('change', () => { IB.project = IB.ui.proj.value; IB.dataSig = null; IB.mailSel = null; inboxLoad(true); });
    IB.ui.status = h('div', {class: 'ib-status'});
    IB.ui.editor = menuButton(t('ib.editor'), 'code', editorMenuItems, {withText: true, kind: 'ghost', size: 'sm'});
    IB.ui.body = h('div', {class: 'ib-body'});
    root.append(h('div', {class: 'toolbar ib-toolbar'}, tabs, IB.ui.proj, h('span', {class: 'spacer'}), IB.ui.status, IB.ui.editor), IB.ui.body);
    inboxTab(IB.tab, true);
  }

  function inboxTab(id, first) {
    IB.tab = id;
    lsSet('devpanel.inboxTab', id);
    if (!IB.ui) return;
    for (const k of Object.keys(IB.ui.tabs)) IB.ui.tabs[k].btn.setAttribute('aria-pressed', String(k === id));
    IB.dataSig = null;
    IB.ui.body.replaceChildren(h('div', {class: 'row muted ib-loading'}, spinner(), t('common.loading')));
    IB.view = null;
    if (S.state) {
      fillInboxProjects(S.state, true);
      renderInboxStatus(S.state);
    }
    if (!first || S.state) inboxLoad(true);
  }

  function fillInboxProjects(st, force) {
    const sel = IB.ui.proj;
    const sig = lang + '|' + IB.tab + '|' + st.projects.map((p) => p.id + ':' + p.name).join('|');
    if (!force && sel.__sig === sig) return;
    sel.__sig = sig;
    const opts = [h('option', {value: ''}, IB.tab === 'errors' ? t('ib.pickProject') : t('ib.allProjects'))];
    for (const p of st.projects) opts.push(h('option', {value: p.id}, p.name));
    sel.replaceChildren(...opts);
    if (IB.project && !st.projects.some((p) => p.id === IB.project)) IB.project = '';
    sel.value = IB.project;
  }

  function renderInboxStatus(st) {
    const ib = st.inbox || {};
    const s = IB.tab === 'mail' ? ib.mail : IB.tab === 'dumps' ? ib.dumps : null;
    const ed = st.settings.editor || 'vscode';
    const label = IB.ui.editor.querySelector('.btn-label');
    if (label) label.textContent = ed === 'none' ? t('ib.editorOff') : EDITOR_LABEL[ed];
    IB.ui.editor.hidden = IB.tab === 'mail';
    const sig = [lang, IB.tab, s && s.enabled, s && s.listening, s && s.error, s && s.port].join('|');
    if (IB.ui.status.__sig === sig) return;
    IB.ui.status.__sig = sig;
    if (!s) { IB.ui.status.replaceChildren(); return; }
    const key = IB.tab === 'mail' ? 'mailCatcher' : 'catchDumps';
    const state = !s.enabled ? chip(t('ib.off'), {dot: 'dot'})
      : s.listening ? chip(t(IB.tab === 'mail' ? 'ib.mail.listening' : 'ib.dump.listening', {port: s.port}), {kind: 'ok', dot: 'dot-ok pulse', mono: true})
        : s.error === 'PORT_BUSY' ? chip(t('ib.portBusy', {port: s.port}), {kind: 'warn', icon: 'alert', title: t('ib.portBusyHint')})
          : chip(t('ib.starting'), {dot: 'dot-busy pulse'});
    const sw = makeSwitch({checked: !!s.enabled, label: t(IB.tab === 'mail' ? 'ib.mail.switch' : 'ib.dump.switch'), onToggle: async (v, el) => {
      el.disabled = true;
      const r = await api('POST', '/api/settings', {[key]: v});
      el.disabled = false;
      if (!r.ok) return failToast(t('ib.saveFail'), r);
      toast('success', v ? t(IB.tab === 'mail' ? 'ib.mail.onToast' : 'ib.dump.onToast') : t(IB.tab === 'mail' ? 'ib.mail.offToast' : 'ib.dump.offToast'));
      await refreshNow();
    }});
    IB.ui.status.replaceChildren(state, h('span', {class: 'row ib-switch'}, sw, h('span', {class: 'small muted'}, t(IB.tab === 'mail' ? 'ib.mail.switch' : 'ib.dump.switch'))));
  }

  function updateInbox(st) {
    if (!IB.ui) return;
    const ib = st.inbox || {};
    const m = ib.mail || {};
    const d = ib.dumps || {};
    IB.ui.tabs.mail.count.textContent = m.unread ? String(m.unread) : '';
    IB.ui.tabs.dumps.count.textContent = d.unread ? String(d.unread) : '';
    IB.ui.tabs.errors.count.textContent = ib.errors ? String(ib.errors) : '';
    for (const k of Object.keys(IB.ui.tabs)) IB.ui.tabs[k].count.classList.toggle('is-hot', !!IB.ui.tabs[k].count.textContent);
    fillInboxProjects(st, false);
    renderInboxStatus(st);
    const sig = IB.tab === 'mail' ? [m.count, m.latest && m.latest.id].join('|')
      : IB.tab === 'dumps' ? [d.newest, d.count].join('|')
        : st.projects.map((p) => p.id + ':' + (p.newErrors || 0)).join(',');
    if (IB.dataSig !== sig) {
      const first = IB.dataSig === null;
      IB.dataSig = sig;
      if (!first) inboxLoad(false);
    }
  }

  function inboxLoad(reset) {
    if (!IB.mounted) return;
    if (IB.tab === 'mail') loadMail(reset);
    else if (IB.tab === 'dumps') loadDumps(reset);
    else loadErrors(reset);
  }

  /* ----- Mail ----- */
  function addrText(a) { return a ? (a.name ? a.name + ' <' + a.address + '>' : a.address) : ''; }
  function addrShort(a) { return a ? (a.name || a.address) : ''; }

  async function loadMail(reset) {
    const qs = new URLSearchParams();
    if (IB.project) qs.set('project', IB.project);
    if (IB.mailQ) qs.set('q', IB.mailQ);
    const r = await api('GET', '/api/mail?' + qs.toString());
    if (!IB.mounted || IB.tab !== 'mail') return;
    if (!r.ok) { IB.ui.body.replaceChildren(callout('bad', t('ib.loadFail'), errorText(r))); return; }
    const items = arr(r.items);
    if (!IB.view || IB.view.kind !== 'mail' || reset) buildMailView(r);
    if (!items.length && !IB.mailQ) { IB.view.split.hidden = true; IB.view.empty.hidden = false; IB.view.empty.replaceChildren(mailEmpty(r.status || {})); } else { IB.view.split.hidden = false; IB.view.empty.hidden = true; }
    IB.view.total.textContent = IB.mailQ ? tn('ib.mail.found', items.length) : tn('ib.mail.count', items.length);
    renderMailList(items);
    if (IB.mailSel && items.some((x) => x.id === IB.mailSel)) { if (reset || !IB.view.shown) openMail(IB.mailSel); }
    else if (items.length && (reset || !IB.mailSel)) openMail(items[0].id);
    else if (!items.length) { IB.mailSel = null; IB.view.viewer.replaceChildren(h('div', {class: 'ib-viewer-empty muted'}, icon('mail'), t('ib.mail.pick'))); }
  }

  function mailEmpty(s) {
    const port = s.port || 1025;
    const snippet = 'MAIL_MAILER=smtp\nMAIL_HOST=127.0.0.1\nMAIL_PORT=' + port + '\nMAIL_ENCRYPTION=null';
    return h('div', {class: 'ib-empty'},
      emptyState({icon: 'mail', title: t('ib.mail.emptyTitle'), text: t('ib.mail.emptyText')}),
      h('div', {class: 'ib-how'},
        h('div', {class: 'ib-how-item'}, icon('play'), h('div', null, h('b', null, t('ib.mail.how1t')), h('p', null, t('ib.mail.how1')))),
        h('div', {class: 'ib-how-item'}, icon('shield'), h('div', null, h('b', null, t('ib.mail.how2t')), h('p', null, t('ib.mail.how2')))),
        h('div', {class: 'ib-how-item'}, icon('terminal'), h('div', null, h('b', null, t('ib.mail.how3t')), h('p', null, t('ib.mail.how3')),
          h('div', {class: 'ib-snippet'}, h('pre', {dir: 'ltr'}, snippet), copyButton(snippet))))));
  }

  function buildMailView() {
    const search = h('input', {class: 'input', type: 'search', placeholder: t('ib.mail.searchPh'), 'aria-label': t('ib.mail.searchPh'), value: IB.mailQ, autocomplete: 'off', spellcheck: 'false'});
    search.addEventListener('input', debounce(() => { IB.mailQ = search.value.trim(); loadMail(false); }, 300));
    const total = h('span', {class: 'muted small'});
    const list = h('div', {class: 'ib-mail-list', role: 'listbox', 'aria-label': t('ib.tab.mail')});
    const viewer = h('div', {class: 'ib-viewer'});
    const readAll = btn(t('ib.mail.readAll'), {size: 'sm', kind: 'ghost', icon: 'check', onClick: async () => { await api('POST', '/api/mail/read-all', {}); await refreshNow(); loadMail(false); }});
    const clearAll = btn(t('ib.mail.clear'), {size: 'sm', kind: 'ghost', icon: 'trash', onClick: async () => {
      const yes = await confirmDialog({title: t('ib.mail.clearQ'), danger: true, icon: 'trash', message: IB.project ? t('ib.mail.clearProjMsg', {name: (findProject(IB.project) || {}).name || ''}) : t('ib.mail.clearMsg'), confirmLabel: t('ib.mail.clearYes')});
      if (!yes) return;
      const r = await api('POST', '/api/mail/clear', {confirm: true, project: IB.project || null});
      if (!r.ok) return failToast(t('ib.mail.clearFail'), r);
      IB.mailSel = null;
      toast('success', tn('ib.mail.cleared', r.removed || 0));
      await refreshNow();
      loadMail(true);
    }});
    const split = h('div', {class: 'ib-split'},
      h('section', {class: 'ib-col ib-col-list panel'},
        h('div', {class: 'ib-col-head'}, h('div', {class: 'search ib-search'}, icon('search'), search)),
        h('div', {class: 'ib-col-sub'}, total, h('span', {class: 'spacer'}), readAll, clearAll),
        list),
      h('section', {class: 'ib-col ib-col-view panel'}, viewer));
    const empty = h('div', {hidden: true});
    IB.view = {kind: 'mail', list, viewer, total, split, empty, shown: false};
    IB.ui.body.replaceChildren(split, empty);
  }

  function renderMailList(items) {
    const list = IB.view.list;
    if (!items.length) { list.replaceChildren(h('div', {class: 'ib-list-empty muted small'}, t('ib.mail.noMatch'))); return; }
    list.replaceChildren(...items.map((x) => {
      const to = arr(x.to).map(addrShort).filter(Boolean);
      const row = h('button', {type: 'button', class: ['ib-mail', !x.read && 'is-unread', IB.mailSel === x.id && 'is-active'], role: 'option', 'aria-selected': String(IB.mailSel === x.id), dataset: {id: x.id}},
        h('span', {class: 'ib-mail-top'},
          !x.read ? h('span', {class: 'ib-unread-dot', 'aria-label': t('ib.mail.unread')}) : null,
          h('span', {class: 'ib-mail-from'}, addrShort(x.from) || t('ib.mail.noFrom')),
          agoEl(x.at)),
        h('span', {class: 'ib-mail-subj'}, x.subject || t('ib.noSubject')),
        x.preview ? h('span', {class: 'ib-mail-prev'}, x.preview) : null,
        h('span', {class: 'ib-mail-meta'},
          to.length ? h('span', {class: 'ib-mail-to', dir: 'auto'}, t('ib.mail.toShort', {to: to.slice(0, 2).join(', ') + (to.length > 2 ? ' +' + (to.length - 2) : '')})) : null,
          x.attachments ? h('span', {class: 'ib-att-ic', title: tn('ib.mail.atts', x.attachments)}, icon('file'), String(x.attachments)) : null,
          !IB.project ? projectChip(x.project) : null));
      row.addEventListener('click', () => openMail(x.id));
      return row;
    }));
  }

  async function openMail(id) {
    IB.mailSel = id;
    IB.view.shown = true;
    for (const el of IB.view.list.querySelectorAll('.ib-mail')) {
      const on = el.dataset.id === id;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) { el.classList.remove('is-unread'); const dot = el.querySelector('.ib-unread-dot'); if (dot) dot.remove(); }
    }
    const viewer = IB.view.viewer;
    viewer.replaceChildren(h('div', {class: 'row muted ib-loading'}, spinner(), t('common.loading')));
    const r = await api('GET', '/api/mail/' + enc(id));
    if (!IB.mounted || IB.tab !== 'mail' || IB.mailSel !== id) return;
    if (!r.ok) { viewer.replaceChildren(callout('bad', t('ib.loadFail'), errorText(r))); return; }
    refreshSoon();
    const m = r.mail || {};
    const people = [
      [t('ib.mail.from'), addrText(m.from)],
      arr(m.to).length ? [t('ib.mail.to'), arr(m.to).map(addrText).join(', ')] : null,
      arr(m.cc).length ? [t('ib.mail.cc'), arr(m.cc).map(addrText).join(', ')] : null,
      arr(m.bcc).length ? [t('ib.mail.bcc'), arr(m.bcc).join(', '), t('ib.mail.bccHint')] : null,
      arr(r.replyTo).length ? [t('ib.mail.replyTo'), arr(r.replyTo).map(addrText).join(', ')] : null
    ].filter(Boolean);
    const views = h('div', {class: 'seg ib-mail-views', role: 'tablist'});
    const width = h('div', {class: 'seg ib-width', role: 'group', 'aria-label': t('ib.mail.widthAria')});
    const pane = h('div', {class: 'ib-mail-pane'});
    const frame = r.htmlUrl ? h('iframe', {class: 'ib-frame', src: r.htmlUrl, title: m.subject || t('ib.noSubject'), sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer', loading: 'lazy'}) : null;
    const frameWrap = frame ? h('div', {class: 'ib-frame-wrap'}, frame) : null;
    const textPane = h('pre', {class: 'ib-text', dir: 'auto'}, r.text != null ? r.text : t('ib.mail.noText'));
    const headPane = h('div', {class: 'ib-headers'}, arr(r.headers).map((x) => h('div', {class: 'ib-hrow'}, h('span', {class: 'ib-hname', dir: 'ltr'}, x.name), h('span', {class: 'ib-hval', dir: 'auto'}, x.value))));
    const show = (which) => {
      for (const b of views.children) b.setAttribute('aria-pressed', String(b.dataset.v === which));
      width.hidden = which !== 'html';
      pane.replaceChildren(which === 'html' && frameWrap ? frameWrap : which === 'headers' ? headPane : textPane);
      lsSet('devpanel.mailView', which);
    };
    const opts = [frame ? {v: 'html', icon: 'eye', label: t('ib.mail.html')} : null, {v: 'text', icon: 'file', label: t('ib.mail.text')}, {v: 'headers', icon: 'list', label: t('ib.mail.headers')}].filter(Boolean);
    for (const o of opts) {
      const b = h('button', {type: 'button', class: 'seg-btn', role: 'tab', dataset: {v: o.v}}, icon(o.icon), o.label);
      b.addEventListener('click', () => show(o.v));
      views.appendChild(b);
    }
    for (const w of [{v: 'desktop', icon: 'monitor', label: t('ib.mail.desktop')}, {v: 'mobile', icon: 'phone', label: t('ib.mail.mobile')}]) {
      const b = h('button', {type: 'button', class: 'seg-btn', 'aria-pressed': String(w.v === (lsGet('devpanel.mailWidth') || 'desktop')), title: w.label, 'aria-label': w.label}, icon(w.icon));
      b.addEventListener('click', () => {
        lsSet('devpanel.mailWidth', w.v);
        for (const x of width.children) x.setAttribute('aria-pressed', String(x === b));
        if (frameWrap) frameWrap.classList.toggle('is-mobile', w.v === 'mobile');
      });
      width.appendChild(b);
    }
    if (frameWrap) frameWrap.classList.toggle('is-mobile', lsGet('devpanel.mailWidth') === 'mobile');
    const atts = arr(r.attachments).filter((a) => !a.inline);
    const del = btn(t('ib.mail.delete'), {size: 'sm', kind: 'ghost', icon: 'trash', onClick: async () => {
      const res = await api('POST', '/api/mail/delete', {ids: [id]});
      if (!res.ok) return failToast(t('ib.mail.clearFail'), res);
      IB.mailSel = null;
      await refreshNow();
      loadMail(true);
    }});
    viewer.replaceChildren(
      h('div', {class: 'ib-mail-head'},
        h('div', {class: 'row ib-mail-titlebar'},
          h('h2', {class: 'ib-mail-title', dir: 'auto'}, m.subject || t('ib.noSubject')),
          h('span', {class: 'spacer'}),
          h('a', {class: 'btn btn-ghost btn-sm', href: r.rawUrl, download: (m.id || 'mail') + '.eml', title: t('ib.mail.eml')}, icon('download'), h('span', {class: 'btn-label'}, '.eml')),
          del),
        h('div', {class: 'ib-people'}, people.map((x) => h('div', {class: 'ib-prow'}, h('span', {class: 'ib-plabel'}, x[0]), h('span', {class: 'ib-pval', dir: 'auto'}, x[1]), x[2] ? h('span', {class: 'ib-phint', title: x[2]}, icon('info')) : null))),
        h('div', {class: 'row ib-mail-sub'}, agoEl(m.at), m.size ? h('span', {class: 'muted small'}, fmtBytes(m.size)) : null, projectChip(m.project), h('span', {class: 'spacer'}), width, views)),
      atts.length ? h('div', {class: 'ib-atts'}, atts.map((a) => h('a', {class: 'ib-att', href: a.url, download: a.filename, title: a.type}, icon('file'), h('span', {class: 'ib-att-name', dir: 'auto'}, a.filename), h('span', {class: 'muted small'}, fmtBytes(a.size))))) : null,
      pane);
    const saved = lsGet('devpanel.mailView');
    show(opts.some((o) => o.v === saved) ? saved : opts[0].v);
  }

  /* ----- Dumps ----- */
  const KEY_PREFIX = {public: '+', protected: '#', private: '-', meta: '~', dynamic: '+'};
  function dumpKey(n) {
    if (n.k == null || n.k === undefined) return null;
    if (n.kt === 'index') return h('span', {class: 'dk-index'}, String(n.k), h('span', {class: 'dk-arrow'}, ' => '));
    if (n.kt === 'key') return h('span', {class: 'dk-key'}, '"' + n.k + '"', h('span', {class: 'dk-arrow'}, ' => '));
    return h('span', {class: 'dk-prop dk-' + n.kt, title: n.kt + (n.scope ? ' (' + n.scope + ')' : '')}, (KEY_PREFIX[n.kt] || '') + n.k, h('span', {class: 'dk-arrow'}, ': '));
  }
  function dumpScalar(n) {
    if (n.t === 'string') {
      const cut = n.cut ? h('span', {class: 'dv-cut'}, '…+' + n.cut) : null;
      return h('span', {class: 'dv-str', title: (n.bin ? 'binary ' : '') + 'string(' + n.len + ')'}, '"', h('span', {class: 'dv-strtxt'}, n.v), '"', cut);
    }
    if (n.t === 'integer' || n.t === 'double') return h('span', {class: 'dv-num'}, String(n.v));
    if (n.t === 'boolean') return h('span', {class: 'dv-bool'}, n.v ? 'true' : 'false');
    if (n.t === 'NULL') return h('span', {class: 'dv-null'}, 'null');
    return h('span', {class: 'dv-other'}, n.v == null ? n.t : String(n.v));
  }
  function dumpNode(n, depth) {
    if (!n) return h('span', {class: 'dv-null'}, '?');
    const key = dumpKey(n);
    if (n.t !== 'array' && n.t !== 'object' && n.t !== 'resource') return h('div', {class: 'dn'}, key, dumpScalar(n));
    const kids = arr(n.c);
    const head = n.t === 'array'
      ? h('span', {class: 'dv-type'}, 'array:' + (n.n != null ? n.n : kids.length), ' ', h('span', {class: 'dv-br'}, '['))
      : h('span', {class: 'dv-type'}, h('span', {class: n.t === 'object' ? 'dv-class' : 'dv-res'}, n.cls || n.t), n.id ? h('span', {class: 'dv-id'}, ' #' + n.id) : null, ' ', h('span', {class: 'dv-br'}, '{'));
    const closeCh = n.t === 'array' ? ']' : '}';
    const close = h('span', {class: 'dv-br'}, closeCh);
    if (!kids.length) {
      const note = n.ref ? h('span', {class: 'dv-cut'}, ' …') : n.cut ? h('span', {class: 'dv-cut'}, ' …' + n.cut) : null;
      return h('div', {class: 'dn'}, key, head, note, close);
    }
    const det = h('details', {class: 'dn dn-hash', open: depth < 2},
      h('summary', null, key, head, h('span', {class: 'dv-fold muted'}, ' … '), h('span', {class: 'dv-fold dv-br'}, closeCh)),
      h('div', {class: 'dn-kids'}, kids.map((c) => dumpNode(c, depth + 1)), n.cut ? h('div', {class: 'dv-cut'}, '…' + n.cut) : null),
      h('div', {class: 'dn-close'}, close));
    return det;
  }

  async function loadDumps() {
    const qs = new URLSearchParams();
    if (IB.project) qs.set('project', IB.project);
    const r = await api('GET', '/api/inbox/dumps?' + qs.toString());
    if (!IB.mounted || IB.tab !== 'dumps') return;
    if (!r.ok) { IB.ui.body.replaceChildren(callout('bad', t('ib.loadFail'), errorText(r))); return; }
    const items = arr(r.items);
    const st = r.status || {};
    if (st.unread) api('POST', '/api/inbox/dumps/seen', {}).then(() => refreshSoon());
    const clear = btn(t('ib.dump.clear'), {size: 'sm', kind: 'ghost', icon: 'eraser', disabled: !items.length, onClick: async () => {
      await api('POST', '/api/inbox/dumps/clear', {project: IB.project || null});
      await refreshNow();
      loadDumps();
    }});
    if (!items.length) {
      IB.ui.body.replaceChildren(h('div', {class: 'ib-empty'},
        emptyState({icon: 'code', title: t('ib.dump.emptyTitle'), text: t('ib.dump.emptyText')}),
        h('div', {class: 'ib-how'},
          h('div', {class: 'ib-how-item'}, icon('code'), h('div', null, h('b', null, t('ib.dump.how1t')), h('p', null, t('ib.dump.how1')), h('div', {class: 'ib-snippet'}, h('pre', {dir: 'ltr'}, "dump($order);\ndump(request()->all());"), copyButton("dump($order);")))),
          h('div', {class: 'ib-how-item'}, icon('eye'), h('div', null, h('b', null, t('ib.dump.how2t')), h('p', null, t('ib.dump.how2')))),
          h('div', {class: 'ib-how-item'}, icon('info'), h('div', null, h('b', null, t('ib.dump.how3t')), h('p', null, t('ib.dump.how3')))))));
      return;
    }
    const cards = items.map((x) => {
      const root = projectRoot(x.project);
      const where = x.uri ? h('span', {class: 'ib-req', dir: 'ltr'}, x.method ? h('b', null, x.method + ' ') : null, x.uri) : x.cli ? h('span', {class: 'ib-req', dir: 'ltr', title: x.cli}, h('b', null, 'CLI ')) : null;
      return h('article', {class: 'ib-dump panel'},
        h('header', {class: 'ib-dump-head'},
          fileLink(x.file, x.line, root),
          x.label ? chip(x.label, {kind: 'accent'}) : null,
          where,
          h('span', {class: 'spacer'}),
          !IB.project ? projectChip(x.project) : null,
          agoEl(x.at),
          x.text ? copyButton(x.text, t('ib.dump.copy')) : null),
        x.ok
          ? h('div', {class: 'ib-tree', dir: 'ltr'}, dumpNode(x.tree, 0), x.truncated ? h('div', {class: 'dv-cut'}, t('ib.dump.truncated')) : null)
          : callout('warn', t('ib.dump.decodeFail'), x.error === 'NO_VAR_DUMPER' ? t('ib.dump.noVarDumper') : x.error));
    });
    IB.ui.body.replaceChildren(
      h('div', {class: 'row ib-dump-bar'}, h('span', {class: 'muted small'}, tn('ib.dump.count', items.length)), h('span', {class: 'spacer'}), h('span', {class: 'muted small'}, t('ib.dump.memoryNote')), clear),
      h('div', {class: 'ib-dumps'}, cards));
  }

  /* ----- Errors ----- */
  function levelKind(l) { return l === 'WARNING' ? 'warn' : /^(ERROR|CRITICAL|ALERT|EMERGENCY)$/.test(l) ? 'bad' : 'info'; }
  async function loadErrors(reset) {
    if (!IB.project) {
      const ps = S.state ? S.state.projects : [];
      IB.ui.body.replaceChildren(ps.length ? h('section', {class: 'panel'},
        h('div', {class: 'panel-head'}, h('div', {class: 'panel-title'}, icon('bug'), t('ib.err.pickTitle')), h('span', {class: 'panel-sub'}, t('ib.err.pickSub'))),
        h('div', {class: 'check-list'}, ps.slice().sort((a, b) => (b.newErrors || 0) - (a.newErrors || 0)).map((p) => {
          const row = h('div', {class: 'check-item', tabindex: '0', role: 'button'},
            h('span', {class: ['check-icon', p.newErrors ? 'is-bad' : 'is-ok']}, icon(p.newErrors ? 'bug' : 'check-circle')),
            h('span', {class: 'check-main grow'}, h('span', {class: 'check-title'}, p.name), h('span', {class: 'check-desc ltr'}, p.path)),
            p.newErrors ? chip(tn('ib.err.newChip', p.newErrors), {kind: 'bad'}) : chip(t('ib.err.clean'), {kind: 'ok'}));
          const go = () => { IB.project = p.id; IB.ui.proj.value = p.id; IB.dataSig = null; loadErrors(true); };
          row.addEventListener('click', go);
          row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
          return row;
        }))) : emptyState({icon: 'bug', title: t('ib.err.noProjects')}));
      return;
    }
    const pid = IB.project;
    const qs = new URLSearchParams({level: IB.errLevel});
    if (IB.errQ) qs.set('q', IB.errQ);
    const r = await api('GET', '/api/projects/' + enc(pid) + '/errors?' + qs.toString());
    if (!IB.mounted || IB.tab !== 'errors' || IB.project !== pid) return;
    if (!r.ok) { IB.ui.body.replaceChildren(callout('bad', t('ib.loadFail'), errorText(r))); return; }
    const p = findProject(pid) || {};
    const counts = r.counts || {};
    if (!IB.view || IB.view.kind !== 'errors' || IB.view.pid !== pid || reset) {
      const levels = h('div', {class: 'seg', role: 'group', 'aria-label': t('ib.err.levelAria')});
      const lv = {};
      for (const k of ['errors', 'warnings', 'all']) {
        const count = h('span', {class: 'seg-count'});
        const b = h('button', {type: 'button', class: 'seg-btn', 'aria-pressed': String(IB.errLevel === k)}, t('ib.err.lv.' + k), count);
        b.addEventListener('click', () => { IB.errLevel = k; for (const x of Object.keys(lv)) lv[x].btn.setAttribute('aria-pressed', String(x === k)); loadErrors(false); });
        lv[k] = {btn: b, count};
        levels.appendChild(b);
      }
      const search = h('input', {class: 'input', type: 'search', placeholder: t('ib.err.searchPh'), 'aria-label': t('ib.err.searchPh'), value: IB.errQ, autocomplete: 'off', spellcheck: 'false'});
      search.addEventListener('input', debounce(() => { IB.errQ = search.value.trim(); loadErrors(false); }, 300));
      const seen = btn(t('ib.err.seen'), {size: 'sm', icon: 'check', onClick: async (ev) => {
        const b = ev.currentTarget;
        setBusy(b, true);
        const res = await api('POST', '/api/projects/' + enc(pid) + '/errors/seen', {});
        setBusy(b, false);
        if (!res.ok) return failToast(t('ib.saveFail'), res);
        await refreshNow();
        loadErrors(false);
      }});
      const list = h('div', {class: 'ib-errs'});
      IB.view = {kind: 'errors', pid, lv, list, seen, files: h('div', {class: 'muted small ib-files'})};
      IB.ui.body.replaceChildren(
        h('div', {class: 'row ib-err-bar'}, levels, h('div', {class: 'search ib-search'}, icon('search'), search), h('span', {class: 'spacer'}), seen),
        list, IB.view.files);
    }
    for (const k of ['errors', 'warnings', 'all']) IB.view.lv[k].count.textContent = counts[k] ? String(counts[k]) : '';
    IB.view.seen.disabled = !counts.newErrors;
    IB.view.files.replaceChildren(arr(r.files).length ? h('span', {dir: 'ltr'}, t('ib.err.readFrom') + ' ' + arr(r.files).map((f) => shortPath(f, p.path)).join(' · ')) : h('span', null, t('ib.err.noLog', {dir: r.logDir || ''})));
    const groups = arr(r.groups);
    if (!groups.length) {
      IB.view.list.replaceChildren(emptyState({small: true, icon: 'check-circle', title: IB.errQ ? t('ib.err.noMatch') : t('ib.err.noneTitle'), text: IB.errQ ? null : t('ib.err.noneText')}));
      return;
    }
    IB.view.list.replaceChildren(...groups.map((g) => errorRow(g, p.path)));
  }

  function errorRow(g, root) {
    const e = g.entry || {};
    const ex = e.exception;
    const when = e.ts ? new Date(e.ts).toISOString() : null;
    const isOpen = IB.open.has(g.key);
    const head = h('div', {class: 'ib-err-head', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen)},
      h('span', {class: 'ib-err-lv'}, chip(e.level || '?', {kind: levelKind(e.level)}), g.count > 1 ? h('span', {class: 'ib-err-x', title: tn('ib.err.times', g.count)}, '×' + g.count) : null),
      h('span', {class: 'ib-err-main'},
        h('span', {class: 'ib-err-msg', dir: 'auto'}, (ex && ex.message) || e.message || '-'),
        h('span', {class: 'ib-err-sub'},
          ex ? h('code', {class: 'ib-err-class', dir: 'ltr'}, ex.class.split('\\').pop()) : (e.source === 'php' ? h('code', {class: 'ib-err-class'}, 'PHP') : null),
          e.where ? fileLink(e.where.file, e.where.line, root) : null,
          g.newCount ? chip(t('ib.err.new'), {kind: 'bad', cls: 'ib-new'}) : null)),
      h('span', {class: 'ib-err-when'}, agoEl(when), h('span', {class: 'ib-chev'}, icon('chevron-down'))));
    const body = h('div', {class: 'ib-err-body', hidden: !isOpen});
    const row = h('div', {class: ['ib-err', 'is-' + levelKind(e.level), isOpen && 'is-open', g.newCount && 'is-new']}, head, body);
    const fill = () => {
      if (body.__filled) return;
      body.__filled = true;
      const frames = arr(e.frames);
      const rows = [];
      let vendorRun = [];
      const flush = () => {
        if (!vendorRun.length) return;
        const run = vendorRun;
        vendorRun = [];
        const more = h('button', {type: 'button', class: 'ib-vendor-toggle'}, icon('chevron-right'), tn('ib.err.vendorFrames', run.length));
        const box = h('div', {class: 'ib-vendor', hidden: true}, run.map(frameRow));
        more.addEventListener('click', () => { box.hidden = !box.hidden; more.classList.toggle('is-open', !box.hidden); });
        rows.push(more, box);
      };
      function frameRow(f) {
        return h('div', {class: ['ib-frame-row', f.vendor && 'is-vendor']}, h('span', {class: 'ib-fn'}, '#' + f.n), f.file ? fileLink(f.file, f.line, root) : h('span', {class: 'muted'}, '[internal]'), f.call ? h('code', {class: 'ib-call', dir: 'ltr'}, f.call) : null);
      }
      for (const f of frames) { if (f.vendor) vendorRun.push(f); else { flush(); rows.push(frameRow(f)); } }
      flush();
      const raw = g.raw || '';
      body.replaceChildren(
        ex && e.message && ex.message !== e.message ? h('p', {class: 'ib-err-full', dir: 'auto'}, e.message) : null,
        ex ? h('div', {class: 'row ib-err-ex'}, h('code', {dir: 'ltr'}, ex.class), ex.code && ex.code !== '0' ? chip('code ' + ex.code, {mono: true}) : null, fileLink(ex.file, ex.line, root)) : null,
        rows.length ? h('div', {class: 'ib-stack'}, h('div', {class: 'ib-stack-title'}, icon('layers'), t('ib.err.stack')), rows) : null,
        h('details', {class: 'ib-raw'}, h('summary', null, icon('log'), t('ib.err.raw'), raw ? copyButton(raw) : null), h('pre', {dir: 'ltr'}, raw)),
        h('div', {class: 'row muted small'}, g.count > 1 ? t('ib.err.range', {first: g.firstTime || '-', last: g.lastTime || '-', n: g.count}) : (e.time || ''), h('span', {class: 'ltr'}, ' · ' + shortPath(e.file || '', root))));
    };
    const toggle = () => {
      const open = body.hidden;
      body.hidden = !open;
      row.classList.toggle('is-open', open);
      head.setAttribute('aria-expanded', String(open));
      if (open) { IB.open.add(g.key); fill(); } else IB.open.delete(g.key);
    };
    head.addEventListener('click', (ev) => { if (ev.target.closest('a,button')) return; toggle(); });
    head.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    if (isOpen) fill();
    return row;
  }

  /** Toasts when something new arrives while another page is open. */
  function inboxNotify(st) {
    const ib = st.inbox;
    if (!ib) return;
    const m = ib.mail || {};
    const d = ib.dumps || {};
    const prev = S.ibPrev;
    S.ibPrev = {mail: m.latest ? m.latest.id : null, dump: d.newest || 0, errors: ib.errors || 0};
    if (!prev || S.page === 'inbox') return;
    if (m.latest && m.latest.id !== prev.mail) {
      toast('info', t('ib.toast.mail'), m.latest.subject || t('ib.noSubject'), {duration: 9000, actions: [{label: t('ib.open'), kind: 'primary', onClick: () => openInbox('mail', null, m.latest.id)}]});
    }
    if ((d.newest || 0) > prev.dump) {
      toast('info', t('ib.toast.dump'), t('ib.toast.dumpText'), {duration: 9000, actions: [{label: t('ib.open'), kind: 'primary', onClick: () => openInbox('dumps')}]});
    }
    if ((ib.errors || 0) > prev.errors) {
      const p = st.projects.find((x) => x.newErrors) || null;
      toast('warn', t('ib.toast.error'), p ? p.name : null, {duration: 9000, actions: [{label: t('ib.open'), kind: 'primary', onClick: () => openInbox('errors', p ? p.id : '')}]});
    }
  }

  /* ===================== Open from GitHub ===================== */
  function repoNameOf(u) {
    const m = /([A-Za-z0-9_.~-]+?)(?:\.git)?\/?$/.exec(String(u || '').trim().replace(/\/(tree|blob|-)\/.*$/, ''));
    return m ? m[1].replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') : '';
  }
  async function openClone() {
    const info = await api('GET', '/api/clone/info');
    if (!info.ok) return failToast(t('clone.loadFail'), info);
    const url = h('input', {class: 'input mono', type: 'text', dir: 'ltr', placeholder: 'https://github.com/owner/repo', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('clone.url')});
    const parent = h('input', {class: 'input mono', type: 'text', dir: 'ltr', value: info.parent || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('clone.parentL')});
    const name = h('input', {class: 'input mono', type: 'text', dir: 'ltr', placeholder: 'my-project', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('clone.nameL')});
    let nameTouched = false;
    name.addEventListener('input', () => { nameTouched = true; preview(); });
    const dest = h('code', {class: 'ltr ib-dest'});
    const preview = () => {
      if (!nameTouched) name.value = repoNameOf(url.value);
      dest.textContent = (parent.value.replace(/[\\/]+$/, '') || '…') + '\\' + (name.value || '…');
    };
    url.addEventListener('input', preview);
    parent.addEventListener('input', preview);
    const browse = btn(t('common.browse'), {size: 'sm', icon: 'folder', onClick: async () => {
      const r = await api('POST', '/api/pick-folder', {});
      if (r.ok && r.path) { parent.value = r.path; preview(); }
    }});
    preview();
    const examples = h('div', {class: 'row clone-examples'}, h('span', {class: 'muted small'}, t('clone.try')),
      ['laravel/laravel', 'filamentphp/demo', 'https://github.com/koel/koel'].map((x) => chip(x, {mono: true, onClick: () => { url.value = x; nameTouched = false; preview(); url.focus(); }})));
    const m = openModal({
      title: t('clone.title'), subtitle: t('clone.sub'), icon: 'branch', size: 'lg',
      body: h('div', {class: 'stack'},
        !info.git ? callout('warn', t('clone.noGitTitle'), t('clone.noGitText')) : null,
        field(t('clone.url'), url, null, t('clone.urlHint')),
        examples,
        h('div', {class: 'clone-grid'},
          field(t('clone.parentL'), h('div', {class: 'clone-parent'}, parent, browse)),
          field(t('clone.nameL'), name)),
        h('div', {class: 'row muted small'}, icon('folder'), t('clone.willBe'), dest),
        h('ol', {class: 'team-steps clone-steps'},
          [['download', 'clone.s1'], ['code', 'clone.s2'], ['package', 'clone.s3'], ['db', 'clone.s4'], ['play', 'clone.s5']].map((x) => h('li', null, icon(x[0]), t(x[1]))))),
      actions: [
        {label: t('common.cancel'), value: null},
        {id: 'go', label: t('clone.go'), kind: 'primary', icon: 'download', disabled: !info.git, onClick: async (mm, b) => {
          const body = {url: url.value.trim(), parent: parent.value.trim(), name: name.value.trim()};
          const res = await modalBusy(mm, b, t('clone.starting'), () => api('POST', '/api/clone', body));
          if (!res.ok || !res.jobId) return failToast(t('clone.fail'), res);
          mm.close();
          showJob(res.jobId, {
            title: t('clone.jobTitle', {name: body.name}), icon: 'branch', closeOnDone: true,
            progress: (job) => (job && job.status === 'running' && job.progress ? {pct: job.progress.done, text: job.progress.text || '', label: t('clone.cloningLabel')} : null),
            onFinal: (job) => { if (job.status === 'done' && job.result && job.result.path) openTeamPlan(job.result.path, {implicit: true, autoStart: true}); }
          });
        }}
      ]
    });
    setTimeout(() => url.focus(), 50);
    return m;
  }

  /* ===================== DB Servers page ===================== */
  const D = {};
  pageImpl.db = {mount: mountDb, update: updateDb};

  function mountDb(root) {
    D.empty = h('div');
    D.grid = h('div', {class: 'grid', 'aria-label': t('db.gridAria')});
    D.unknown = h('div');
    root.append(
      h('div', {class: 'toolbar'},
        btn(t('db.new'), {kind: 'primary', icon: 'plus', onClick: () => openCreateDb()}),
        btn(t('db.rescan'), {icon: 'radar', onClick: (ev) => startScan(ev.currentTarget)}),
        btn(t('pma.open'), {icon: 'globe', onClick: (ev) => openPma({}, ev.currentTarget)}),
        btn(t('pma.stop'), {kind: 'ghost', icon: 'power', onClick: (ev) => stopPma(ev.currentTarget)}),
        h('span', {class: 'spacer'}),
        chip(t('db.oneDatadir'), {kind: 'info', icon: 'info'})),
      D.empty, D.grid, D.unknown);
  }

  function updateDb(st) {
    if (!D.grid) return;
    const list = st.dbServers;
    patchSection(D.empty, list.length ? '' : 'none', () => (list.length ? null : emptyState({
      icon: 'db', title: t('db.emptyTitle'),
      text: t('db.emptyText'),
      actions: [btn(t('rt.scanNow'), {kind: 'primary', icon: 'radar', onClick: (ev) => startScan(ev.currentTarget)}),
        btn(t('db.new'), {icon: 'plus', onClick: () => openCreateDb()})]
    })));
    const projSig = JSON.stringify(st.projects.map((p) => [p.id, p.name]));
    // Other servers' names/status appear in this card's warning list, so they are part of the signature.
    const srvSig = JSON.stringify(list.map((d) => [d.id, d.label, d.port, d.status]));
    reconcile(D.grid, list, (d) => d.id,
      (d) => JSON.stringify(d) + projSig + (arr(d.warnings).some((w) => Array.isArray(w.others)) ? srvSig : '') + '|' + (S.dbPending[d.id] || '') + (S.dbForce[d.id] ? 'F' : '') + JSON.stringify(S.dbOpen[d.id] || null),
      buildDbCard);
    const known = new Set(list.map((d) => d.pid).filter(Boolean));
    const unknown = st.external.db.filter((x) => x && !known.has(x.pid));
    patchSection(D.unknown, JSON.stringify(unknown), () => (unknown.length ? h('section', {class: 'panel', 'aria-label': t('db.unknown')},
      h('div', {class: 'panel-head'}, h('h2', {class: 'panel-title'}, icon('server'), t('db.unknown')), chip(String(unknown.length), {}),
        h('span', {class: 'panel-sub'}, t('db.unknownSub'))),
      h('div', {class: 'unknown-list'}, unknown.map((x) => h('div', {class: 'unknown-row'},
        chip('pid ' + x.pid, {mono: true}),
        arr(x.ports).map((pt) => chip(':' + pt, {mono: true, kind: 'info'})),
        x.exe ? h('span', {class: 'cell-path'}, x.exe) : h('span', {class: 'muted small'}, t('db.unknownPath')))))) : null));
  }

  /** Card subtitle: the label without the "MariaDB 12.3.3 · " prefix that the title already shows. */
  function dbSubtitle(d) {
    const label = String(d.label || '');
    const prefix = serverTitle(d) + ' · ';
    if (label.startsWith(prefix)) return label.slice(prefix.length);
    if (label === serverTitle(d)) return d.created ? t('db.newInstance') : '';
    return label;
  }

  function buildDbCard(d) {
    const pend = S.dbPending[d.id];
    const starting = pend === 'starting' || d.status === 'starting';
    const stopping = pend === 'stopping' || d.status === 'stopping';
    const running = d.status === 'running' && !stopping;
    const busy = starting || stopping;
    const notCtl = d.status === 'running' && !d.controllable;
    const stateText = stopping ? t('status.stopping') : starting ? t('status.starting') : running ? t('status.running') : t('status.stopped');
    const warns = arr(d.warnings);
    const usedBy = arr(d.usedBy).map((id) => findProject(id)).filter(Boolean);

    const head = h('div', {class: 'pc-head'},
      h('span', {class: ['dot', 'status-dot', running ? 'dot-ok pulse' : busy ? 'dot-busy pulse' : null], 'aria-hidden': 'true', title: stateText}),
      h('div', {class: 'pc-title'},
        h('h3', {class: 'pc-name', title: serverTitle(d)}, serverTitle(d)),
        h('div', {class: 'pc-sub', title: d.label || ''}, dbSubtitle(d))),
      h('div', {class: 'pc-side'},
        makeSwitch({
          checked: running || starting, busy, size: 'lg', fk: 'toggle', disabled: notCtl && !busy,
          label: running ? t('db.swStop', {name: serverName(d)}) : t('db.swStart', {name: serverName(d)}),
          title: notCtl ? t('db.notCtl') : running ? t('db.swStopTitle') : t('db.swStartTitle'),
          onToggle: (want) => (want ? startDbServer(d) : stopDbServer(d, null))
        }),
        h('span', {class: ['pc-state', running && 'is-on', busy && 'is-busy']}, stateText)));

    // All warnings (shared datadir, port clash, ...) collapse into one tag; the details open on click.
    const wt = warnTag('d:' + d.id, warns, {kind: 'db', server: d});
    const ports = arr(d.ports).filter((pt) => Number(pt) !== Number(d.port));
    const badges = h('div', {class: 'badges'},
      chip(':' + d.port, {mono: true, kind: 'accent', title: d.portOverride != null ? t('db.portOverrideTitle') : t('db.portIniTitle')}),
      d.portOverride != null ? chip(t('db.override'), {kind: 'info', title: t('db.overrideTitle', {port: d.portOverride})}) : null,
      ports.map((pt) => chip('+:' + pt, {mono: true})),
      notCtl ? chip(t('db.adminChip'), {kind: 'warn', icon: 'lock', title: t('db.adminTitle')}) : null,
      d.startedByPanel ? chip(t('db.byPanel'), {kind: 'accent', icon: 'bolt'}) : null,
      d.created ? chip(t('db.newInstanceChip'), {kind: 'info', icon: 'sparkle'}) : null,
      d.pid ? chip('pid ' + d.pid, {mono: true}) : null,
      wt.tag);

    const meta = h('dl', {class: 'db-meta'},
      h('dt', null, 'Datadir'), h('dd', null, h('span', {class: 'mono', title: d.datadir || ''}, d.datadir || '-'), d.datadir ? copyButton(d.datadir, t('db.copyDatadir')) : null),
      h('dt', null, 'my.ini'), h('dd', null, h('span', {class: 'mono', title: d.defaultsFile || ''}, d.defaultsFile || '-'), d.defaultsFile ? copyButton(d.defaultsFile, t('db.copyIni')) : null));

    const calls = [];
    if (S.dbForce[d.id] && d.status === 'running') {
      calls.push(callout('bad', t('db.gracefulFail'), t('db.forceWarn'),
        [btn(t('db.force'), {kind: 'danger', size: 'sm', icon: 'power', onClick: () => confirmForceStop(d)}),
          btn(t('job.viewLog'), {size: 'sm', icon: 'log', onClick: () => openDbLog(d)})]));
    }
    const used = usedBy.length ? h('div', {class: 'used-by'}, h('span', null, t('db.usedBy')),
      usedBy.map((p) => chip(p.name, {icon: 'grid', title: t('db.viewProject'), onClick: () => { S.flash = p.id; goPage('projects'); }}))) : null;

    const open = S.dbOpen[d.id];
    const foot = h('div', {class: 'pc-foot'},
      btn(t('db.log'), {kind: 'ghost', size: 'sm', icon: 'log', fk: 'log', onClick: () => openDbLog(d)}),
      btn(t('db.databases'), {
        kind: 'ghost', size: 'sm', icon: 'list', fk: 'dbs', disabled: !running,
        title: running ? t('db.dbListTitle') : t('db.runFirst'),
        attrs: {'aria-expanded': String(!!open)}, onClick: () => toggleDatabases(d, null)
      }),
      btn('phpMyAdmin', {kind: 'ghost', size: 'sm', icon: 'globe', fk: 'pma', title: t('pma.dbTitle'), onClick: (ev) => openPma({dbServerId: d.id}, ev.currentTarget)}),
      btn(t('bk.btn'), {kind: 'ghost', size: 'sm', icon: 'layers', fk: 'backups', title: t('bk.btnTitle'), onClick: () => openBackups(d)}),
      btn(t('rep.btn'), {kind: 'ghost', size: 'sm', icon: 'wand', fk: 'repair', title: t('rep.btnTitle'), onClick: () => openRepair(d)}),
      h('span', {class: 'spacer'}),
      menuButton(t('common.more'), 'more', () => dbMoreItems(d), {fk: 'more'}));

    return h('article', {class: ['card', 'db-card', running && 'is-running', busy && 'is-starting', wt.open && 'is-warn-open'], 'aria-label': t('db.cardAria', {name: serverName(d)})},
      head, badges, wt.panel, meta, calls.length ? h('div', {class: 'pc-callouts'}, calls) : null, used, dbListView(d, open), foot);
  }

  function dbListView(d, st) {
    if (!st) return null;
    let content;
    if (st.loading) content = h('div', {class: 'row muted small'}, spinner(), t('common.listLoading'));
    else if (st.error) content = callout('bad', null, st.error, [btn(t('common.retry'), {size: 'sm', icon: 'refresh', onClick: () => { delete S.dbOpen[d.id]; toggleDatabases(d, null); }})]);
    else if (!arr(st.items).length) content = h('p', {class: 'muted small'}, t('db.noUserDbs'));
    else content = h('div', {class: 'db-items'}, st.items.map((x) => h('div', {class: 'db-item', title: x.name},
      h('span', {class: 'mono'}, x.name), h('span', {class: 'size'}, fmtMB(x.sizeMB)))));
    return h('div', {class: 'db-list'},
      h('div', {class: 'db-list-head'}, icon('db'), t('db.databases'), st.items ? chip(String(st.items.length), {}) : null, h('span', {class: 'spacer'}),
        btn(t('db.closeList'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'x', onClick: () => { delete S.dbOpen[d.id]; renderAll(); }})),
      content);
  }

  async function toggleDatabases(d, creds) {
    if (S.dbOpen[d.id] && !creds) { delete S.dbOpen[d.id]; renderAll(); return; }
    S.dbOpen[d.id] = {loading: true};
    renderAll();
    const body = Object.assign({}, creds || {});
    if (!creds && arr(d.usedBy).length) body.projectId = d.usedBy[0];
    const r = await api('POST', '/api/db/' + enc(d.id) + '/databases', body);
    if (!S.dbOpen[d.id]) return;
    if (r.ok) {
      S.dbOpen[d.id] = {items: arr(r.databases)};
    } else if (r.code === 'NEED_CREDENTIALS') {
      S.dbOpen[d.id] = {error: t('db.needLogin')};
      renderAll();
      const c = await askCredentials({title: t('db.loginTitle', {name: serverName(d)}), subtitle: ':' + d.port, message: t('db.loginMsg')});
      if (c) { toggleDatabases(d, c); return; }
      delete S.dbOpen[d.id];
    } else {
      S.dbOpen[d.id] = {error: errorText(r)};
    }
    renderAll();
  }

  async function startDbServer(d) {
    const warns = arr(d.warnings);
    const severe = warns.some((w) => w.level === 'bad' || w.code === 'SHARED_DATADIR');
    const yes = await confirmDialog({
      title: t('db.startQ', {name: serverName(d)}), icon: 'db', tone: severe ? 'bad' : 'warn', size: 'md',
      message: t('db.startMsg'),
      details: h('div', {class: 'stack'},
        kvList([['Datadir', d.datadir || '-', true], ['my.ini', d.defaultsFile || '-', true], [t('common.port'), ':' + d.port, true]]),
        warns.map((w) => callout(w.level === 'bad' ? 'bad' : 'warn', warnTitle(w, 'warndb'), warnBody(w, 'db', d)))),
      confirmLabel: t('db.startYes'), confirmIcon: 'play'
    });
    if (!yes) return;
    S.dbPending[d.id] = 'starting';
    renderAll();
    const r = await api('POST', '/api/db/' + enc(d.id) + '/start', {confirm: true});
    if (!r.ok || !r.jobId) {
      delete S.dbPending[d.id];
      renderAll();
      return failToast(t('db.startFail', {name: serverName(d)}), r);
    }
    showJob(r.jobId, {
      title: t('db.startJob', {name: serverName(d)}), icon: 'db', closeOnDone: true,
      // a failed start offers the crash check / repair right away
      renderResult: (job) => (job.status === 'failed'
        ? h('div', {class: 'row'}, btn(t('rep.checkBtn'), {kind: 'primary', size: 'sm', icon: 'wand', onClick: () => openRepair(findServer(d.id) || d)}))
        : null),
      onFinal: async () => { await refreshNow(); delete S.dbPending[d.id]; renderAll(); }
    });
  }

  /* ===================== Backups (snapshots / dumps) ===================== */
  function fmtStamp(name) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(name || ''));
    return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] : String(name || '');
  }
  function reasonChip(r) {
    const kind = r === 'manual' ? 'accent' : r === 'auto' ? 'info' : 'warn';
    return chip(hasT('bk.reason.' + r) ? t('bk.reason.' + r) : r, {kind});
  }
  /** Backups modal of one DB server: take a snapshot (stopped) / dump (running), restore either. */
  async function openBackups(d) {
    const m = openModal({
      title: t('bk.title', {name: serverName(d)}), subtitle: t('bk.sub'), icon: 'layers', size: 'lg',
      body: h('div', {class: 'row muted'}, spinner(), t('common.loading')),
      actions: [{label: t('common.close'), value: null}]
    });
    const load = async () => {
      const r = await api('GET', '/api/db/' + enc(d.id) + '/backups');
      if (m.closed) return;
      if (!r.ok) { m.body.replaceChildren(callout('bad', t('bk.loadFail'), errorText(r))); return; }
      const cur = findServer(d.id) || d;
      const running = cur.status === 'running';
      const runJob = async (b, path, body, title) => {
        setBusy(b, true);
        const res = await api('POST', '/api/db/' + enc(d.id) + path, Object.assign({confirm: true}, body || {}));
        setBusy(b, false);
        if (!res.ok || !res.jobId) return failToast(title, res);
        showJob(res.jobId, {title, icon: 'layers', progress: (job) => jobProgress(job, true), onFinal: async () => { await refreshNow(); load(); }});
      };
      const snaps = arr(r.snapshots);
      const dumps = arr(r.dumps);
      const snapRows = snaps.length ? h('div', {class: 'check-list'}, snaps.map((s) => h('div', {class: 'check-item bk-row'},
        h('span', {class: 'check-icon'}, icon('layers')),
        h('span', {class: 'check-main grow'},
          h('span', {class: 'check-title row'}, fmtStamp(s.name), reasonChip(s.reason), s.sizeBytes ? h('span', {class: 'muted small'}, fmtBytes(s.sizeBytes)) : null),
          h('span', {class: 'check-desc mono'}, s.path)),
        btn(t('bk.restore'), {size: 'sm', icon: 'refresh', disabled: running, title: running ? t('bk.stopToRestore') : null, onClick: async (ev) => {
          const yes = await confirmDialog({
            title: t('bk.restoreQ'), icon: 'refresh', tone: 'warn', size: 'md', message: t('bk.restoreMsg', {when: fmtStamp(s.name)}),
            details: kvList([['Datadir', cur.datadir || '-', true], [t('bk.keptAs'), (cur.datadir || 'data') + '_before_restore_…', true]]),
            confirmLabel: t('bk.restoreYes'), confirmIcon: 'refresh'
          });
          if (yes) runJob(ev.currentTarget || null, '/restore-snapshot', {name: s.name}, t('bk.restoreJob'));
        }})))) : h('p', {class: 'muted'}, t('bk.noSnaps'));
      const dumpRows = dumps.length ? h('div', {class: 'check-list'}, dumps.map((x) => h('div', {class: 'check-item bk-row'},
        h('span', {class: 'check-icon'}, icon('file')),
        h('span', {class: 'check-main grow'},
          h('span', {class: 'check-title row'}, fmtStamp(x.name), reasonChip(x.reason), h('span', {class: 'muted small'}, tn('bk.dbCount', arr(x.files).length)),
            arr(x.failed).length ? chip(tn('bk.failedCount', x.failed.length), {kind: 'warn'}) : null),
          h('span', {class: 'check-desc'}, h('span', {class: 'row bk-dbs'}, arr(x.files).map((f) => chip(f.db + ' · ' + fmtBytes(f.size), {
            onClick: () => restoreDumpAsk(d, x, f, running, runJob), title: t('bk.restoreDumpTitle')
          })))))))) : h('p', {class: 'muted'}, t('bk.noDumps'));
      const st = r.state || {};
      const set = r.settings || {};
      m.body.replaceChildren(h('div', {class: 'stack'},
        h('div', {class: 'row'},
          btn(t('bk.snapNow'), {kind: 'primary', icon: 'layers', disabled: running, title: running ? t('bk.stopToSnap') : null,
            onClick: (ev) => runJob(ev.currentTarget, '/snapshot', null, t('bk.snapJob'))}),
          btn(t('bk.dumpNow'), {icon: 'file', disabled: !running, title: running ? null : t('bk.startToDump'),
            onClick: (ev) => runJob(ev.currentTarget, '/dump', null, t('bk.dumpJob'))}),
          h('span', {class: 'spacer'}),
          h('span', {class: 'muted small'}, st.lastDumpAt ? t('bk.lastDump', {d: agoText(st.lastDumpAt)}) : t('bk.noDumpYet'))),
        callout('info', null, t('bk.how', {on: t('bk.on.' + (set.snapshotOnStart || 'daily')), keep: set.snapshotKeep || 7, dkeep: set.dumpKeep || 7})),
        h('h3', {class: 'wiz-h'}, icon('layers'), t('bk.snaps'), h('span', {class: 'muted small'}, t('bk.snapsSub'))), snapRows,
        h('h3', {class: 'wiz-h'}, icon('file'), t('bk.dumps'), h('span', {class: 'muted small'}, t('bk.dumpsSub'))), dumpRows,
        h('p', {class: 'muted small mono'}, r.root || '')));
    };
    load();
  }
  async function restoreDumpAsk(d, x, f, running, runJob) {
    if (!running) return toast('warn', t('bk.startToRestoreDump'));
    const stamp = String(x.name).slice(0, 8);
    const target = await promptDialog({
      title: t('bk.restoreDumpQ', {db: f.db}), icon: 'file', label: t('bk.newDbName'), mono: true,
      value: (f.db + '_restored_' + stamp).slice(0, 64), hint: t('bk.newDbHint'),
      validate: (v) => (/^[A-Za-z0-9_$-]{1,64}$/.test(v) ? null : t('bk.badDbName')), confirmLabel: t('bk.restoreYes')
    });
    if (target) runJob(null, '/restore-dump', {name: x.name, db: f.db, target}, t('bk.restoreJob'));
  }

  /* ===================== Repair / rescue ===================== */
  const REP_ICON = {CRASHED_TABLES: 'alert', PRIV_TABLES: 'key', ARIA: 'file', INNODB: 'alert-circle', LOCKED: 'lock', PORT: 'hash', LSN_FUTURE: 'clock', MISSING_IN_ENGINE: 'x'};
  async function openRepair(d) {
    const m = openModal({
      title: t('rep.title', {name: serverName(d)}), subtitle: t('rep.sub'), icon: 'wand', size: 'lg',
      body: h('div', {class: 'row muted'}, spinner(), t('rep.reading')),
      actions: [{label: t('common.close'), value: null}]
    });
    const r = await api('GET', '/api/db/' + enc(d.id) + '/diagnose');
    if (m.closed) return;
    if (!r.ok) { m.body.replaceChildren(callout('bad', t('rep.diagFail'), errorText(r))); return; }
    const issues = arr(r.issues);
    const running = r.status !== 'stopped';
    const hasInno = issues.some((x) => x.code === 'INNODB' || x.code === 'LSN_FUTURE');
    const go = async (path, body, title, b) => {
      const res = await modalBusy(m, b, t('common.startingShort'), () => api('POST', '/api/db/' + enc(d.id) + path, Object.assign({confirm: true}, body || {})));
      if (!res.ok || !res.jobId) return failToast(title, res);
      m.close(true);
      S.dbPending[d.id] = 'starting';
      renderAll();
      showJob(res.jobId, {
        title, icon: 'wand', progress: (job) => jobProgress(job, true),
        renderResult: (job) => repairResult(job, d),
        onFinal: async () => { delete S.dbPending[d.id]; await refreshNow(); renderAll(); }
      });
    };
    m.body.replaceChildren(h('div', {class: 'stack'},
      running ? callout('warn', t('rep.runningTitle'), t('rep.runningText')) : null,
      issues.length
        ? h('div', {class: 'check-list'}, issues.map((x) => h('div', {class: 'check-item'},
          h('span', {class: 'check-icon'}, icon(REP_ICON[x.code] || 'alert')),
          h('span', {class: 'check-main grow'},
            h('span', {class: 'check-title'}, hasT('rep.issue.' + x.code) ? t('rep.issue.' + x.code) : x.code),
            h('span', {class: 'check-desc'}, hasT('rep.fix.' + x.code) ? t('rep.fix.' + x.code) : ''),
            arr(x.tables).length ? h('span', {class: 'check-desc mono'}, arr(x.tables).join(', ')) : null,
            h('span', {class: 'check-desc mono rep-line'}, x.line || '')))))
        : callout('ok', t('rep.noIssues'), t('rep.noIssuesText')),
      h('ul', {class: 'in-facts'}, [t('rep.fact1'), t('rep.fact2'), t('rep.fact3')].map((f) => h('li', null, icon('check'), h('span', null, f)))),
      r.logTail ? h('details', {class: 'rep-log'}, h('summary', null, t('rep.showLog') + (r.errorLog ? ' — ' + r.errorLog : '')), h('pre', {class: 'term-mini', dir: 'ltr'}, r.logTail)) : null));
    m.setActions([
      {label: t('common.close'), left: true, value: null},
      {label: t('rep.rescueBtn'), icon: 'layers', kind: hasInno ? 'primary' : null, disabled: running,
        onClick: async (c, b) => {
          const yes = await confirmDialog({title: t('rep.rescueQ'), icon: 'layers', tone: 'warn', size: 'md', message: t('rep.rescueMsg'), confirmLabel: t('rep.rescueYes')});
          if (yes) go('/rescue', {createServer: true}, t('rep.rescueJob', {name: serverName(d)}), b);
        }},
      {label: t('rep.repairBtn'), icon: 'wand', kind: hasInno ? null : 'primary', disabled: running, autofocus: !running,
        onClick: (c, b) => go('/repair', null, t('rep.repairJob', {name: serverName(d)}), b)}
    ]);
  }
  function repairResult(job, d) {
    const res = job.result && typeof job.result === 'object' ? job.result : {};
    const parts = [];
    if (job.status === 'done' && res.rescued) {
      parts.push(callout('ok', t('rep.rescuedTitle', {n: arr(res.dumps).length}), h('div', {class: 'stack'},
        h('div', null, t('rep.rescuedText', {level: res.level})),
        res.server ? h('div', null, t('rep.rescuedServer', {label: res.server.label, port: res.server.port})) : null,
        arr(res.failed).length ? h('div', null, t('rep.rescuedFailed', {list: res.failed.map((x) => x.db).join(', ')})) : null,
        h('div', {class: 'mono small'}, res.folder || '')),
      [btn(t('in.openDb'), {size: 'sm', icon: 'db', onClick: () => goPage('db')})]));
    } else if (job.status === 'done') {
      parts.push(callout('ok', t('rep.doneTitle'), t('rep.doneText', {snapshot: res.snapshot || '-'})));
    } else if (res.needRescue) {
      parts.push(callout('warn', t('rep.needRescueTitle'), t('rep.needRescueText'),
        [btn(t('rep.rescueBtn'), {size: 'sm', kind: 'primary', icon: 'layers', onClick: () => openRepair(findServer(d.id) || d)})]));
    }
    if (typeof res.logTail === 'string' && res.logTail.trim()) parts.push(h('pre', {class: 'term-mini', dir: 'ltr'}, res.logTail));
    return parts.length ? h('div', {class: 'stack'}, parts) : null;
  }

  async function stopDbServer(d, extra) {
    if (!d.controllable) {
      toast('warn', t('db.cantStop'), t('db.cantStopMsg'));
      return;
    }
    const body = Object.assign({}, extra || {});
    S.dbPending[d.id] = 'stopping';
    renderAll();
    const r = await api('POST', '/api/db/' + enc(d.id) + '/stop', body);
    if (!r.ok || !r.jobId) {
      delete S.dbPending[d.id];
      renderAll();
      if (r.code === 'NEED_CREDENTIALS') return askStopCredentials(d);
      return failToast(t('db.stopFail', {name: serverName(d)}), r);
    }
    showJob(r.jobId, {
      title: body.force ? t('db.forceJob', {name: serverName(d)}) : t('db.stopJob', {name: serverName(d)}), icon: 'power', closeOnDone: true, quietCodes: ['NEED_CREDENTIALS'],
      onFinal: async (job, ctrl) => {
        await refreshNow();
        delete S.dbPending[d.id];
        const code = jobCode(job);
        if (code === 'NEED_CREDENTIALS') {
          renderAll();
          if (ctrl) ctrl.close();
          askStopCredentials(d);
          return;
        }
        if (job.status === 'done') { delete S.dbForce[d.id]; renderAll(); return; }
        if (!body.force) {
          S.dbForce[d.id] = true;
          renderAll();
          confirmForceStop(d);
          return;
        }
        renderAll();
      }
    });
  }
  async function askStopCredentials(d) {
    const c = await askCredentials({
      title: t('db.stopLoginTitle', {name: serverName(d)}), subtitle: ':' + d.port,
      message: t('db.stopLoginMsg'), confirmLabel: t('common.stop')
    });
    if (c) stopDbServer(d, c);
  }
  async function confirmForceStop(d) {
    const yes = await confirmDialog({
      title: t('db.forceQ'), danger: true, icon: 'alert',
      message: t('db.forceMsg'),
      confirmLabel: t('db.forceYes'), cancelLabel: t('common.notNow')
    });
    if (yes) stopDbServer(d, {force: true});
  }

  function openDbLog(d) {
    openDrawer({
      title: t('db.logTitle', {name: serverName(d)}), subtitle: d.datadir || '', icon: 'log',
      fetch: async () => {
        const r = await api('GET', '/api/db/' + enc(d.id) + '/log?lines=200');
        return r.ok ? {ok: true, text: r.text, subtitle: r.errorLogPath ? t('db.errorLog', {path: r.errorLogPath}) : null} : r;
      }
    });
  }
  async function editDbPort(d) {
    const v = await promptDialog({
      title: t('port.change'), subtitle: serverName(d), label: t('db.portLabel'), type: 'number',
      value: d.portOverride != null ? String(d.portOverride) : '', placeholder: String(d.port), mono: true, icon: 'hash',
      hint: t('db.portHint') + (d.status === 'running' ? ' ' + t('db.portHintRunning') : ''),
      validate: (x) => (x === '' || validPort(x) ? null : t('port.invalid'))
    });
    if (v == null) return;
    const r = await api('POST', '/api/db/' + enc(d.id) + '/update', {portOverride: v === '' ? null : Number(v)});
    if (!r.ok) return failToast(t('port.saveFail'), r);
    toast('success', v === '' ? t('db.portReset') : t('port.set', {port: v}), serverName(d));
    await refreshNow();
  }
  async function renameDb(d) {
    const v = await promptDialog({
      title: t('common.rename'), subtitle: serverTitle(d), label: t('db.labelField'), value: d.label || '', validate: validateName
    });
    if (v == null || v === d.label) return;
    const r = await api('POST', '/api/db/' + enc(d.id) + '/update', {label: v});
    if (!r.ok) return failToast(t('name.saveFail'), r);
    toast('success', t('name.changed'), v);
    await refreshNow();
  }
  async function removeDb(d) {
    const yes = await confirmDialog({
      title: t('remove.q'), danger: true, icon: 'trash',
      message: t('db.removeMsg', {name: serverName(d)}),
      details: h('code', {class: 'break'}, d.datadir || '-'), confirmLabel: t('remove.yes')
    });
    if (!yes) return;
    const r = await api('POST', '/api/db/' + enc(d.id) + '/remove');
    if (!r.ok) return failToast(t('remove.fail'), r);
    toast('success', t('remove.done'), t('db.dataKept', {path: d.datadir || '-'}), {duration: 8000});
    await refreshNow();
  }
  function dbMoreItems(d) {
    return [
      {label: t('common.rename'), icon: 'pencil', onClick: () => renameDb(d)},
      {label: t('port.change'), icon: 'hash', onClick: () => editDbPort(d)},
      {label: t('db.copyDatadir'), icon: 'copy', disabled: !d.datadir, onClick: () => copyText(d.datadir).then((ok) => toast(ok ? 'success' : 'warn', ok ? t('copy.datadirDone') : t('copy.fail')))},
      d.created ? 'sep' : null,
      d.created ? {label: t('remove.menu'), icon: 'trash', danger: true, disabled: d.status === 'running', title: d.status === 'running' ? t('common.stopFirst') : null, onClick: () => removeDb(d)} : null
    ];
  }

  function suggestDbPort() {
    const range = arr(S.state.settings.dbPortRange);
    const from = range.length === 2 ? Number(range[0]) : 3310;
    const to = range.length === 2 ? Number(range[1]) : 3399;
    const used = new Set();
    for (const d of S.state.dbServers) { used.add(Number(d.port)); for (const pt of arr(d.ports)) used.add(Number(pt)); }
    for (const x of S.state.external.db) for (const pt of arr(x.ports)) used.add(Number(pt));
    for (let pt = from; pt <= to; pt++) if (!used.has(pt)) return pt;
    return from;
  }

  function openCreateDb() {
    const installs = S.state.runtimes.db
      .filter((x) => x && x.ok !== false && x.serverExe && x.installDb && String(x.kind || '').toLowerCase() === 'mariadb')
      .sort((a, b) => compareVer(b.version, a.version));
    if (!installs.length) {
      openModal({
        title: t('db.new'), icon: 'db', size: 'sm',
        body: emptyState({small: true, icon: 'db', title: t('cdb.noInstall'), text: t('cdb.noInstallText')}),
        actions: [{label: t('common.close'), value: null}, {label: t('rt.scanNow'), kind: 'primary', icon: 'radar', onClick: (m) => { m.close(); startScan(null); }}]
      });
      return;
    }
    const instSel = h('select', {class: 'select', id: uid('ci')},
      installs.map((x) => h('option', {value: x.id}, (x.label || dbKindLabel(x.kind) + ' ' + x.version))));
    const nameInput = h('input', {class: 'input mono', id: uid('cn'), type: 'text', placeholder: t('cdb.namePh'), autocomplete: 'off', spellcheck: 'false', dataset: {autofocus: '1'}});
    const portInput = h('input', {class: 'input mono', id: uid('cp'), type: 'number', min: 1024, max: 65535, value: String(suggestDbPort())});
    const preview = h('code', {class: 'break'});
    const err = h('div', {class: 'field-error', 'aria-live': 'polite'});
    const dataDir = S.state.panel.dataDir ? String(S.state.panel.dataDir).replace(/[\\/]+$/, '') : '<data>';
    const updatePreview = () => { preview.textContent = dataDir + '\\db\\' + (nameInput.value.trim() || t('cdb.nameToken')) + '\\data'; };
    nameInput.addEventListener('input', () => { err.textContent = ''; updatePreview(); });
    updatePreview();
    let m = null;
    const create = async () => {
      const name = nameInput.value.trim();
      const port = validPort(portInput.value);
      if (!/^[a-z0-9-]{2,30}$/.test(name)) { err.textContent = t('cdb.nameInvalid'); nameInput.focus(); return; }
      if (!port) { err.textContent = t('port.rangeErr'); portInput.focus(); return; }
      const clash = S.state.dbServers.find((x) => Number(x.port) === port);
      if (clash) { err.textContent = t('cdb.portTaken', {port, name: serverName(clash)}); portInput.focus(); return; }
      const r = await modalBusy(m, m.button('create'), t('common.creating'), () => api('POST', '/api/db/create', {installId: instSel.value, name, port}));
      if (!r.ok || !r.jobId) { err.textContent = errorText(r); return; }
      m.close(true);
      showJob(r.jobId, {title: t('cdb.jobTitle', {name}), icon: 'db', closeOnDone: true, onFinal: () => refreshNow()});
    };
    m = openModal({
      title: t('db.new'), subtitle: t('cdb.sub'), icon: 'db', size: 'md',
      body: [
        field(t('cdb.install'), instSel),
        h('div', {class: 'form-grid'},
          field(t('common.name'), nameInput, null, t('cdb.nameHint')),
          field(t('common.port'), portInput, null, t('cdb.portHint'))),
        callout('info', t('cdb.dataFolder'), h('div', null, t('cdb.dataWhere') + ' ', preview)),
        h('p', {class: 'field-hint'}, t('cdb.note')),
        err
      ],
      actions: [{label: t('common.cancel'), value: null}, {id: 'create', label: t('cdb.create'), kind: 'primary', icon: 'plus', onClick: create}]
    });
  }

  async function startScan(b) {
    if (b) setBusy(b, true, t('scan.starting'));
    const r = await api('POST', '/api/runtimes/scan');
    if (b) setBusy(b, false);
    if (!r.ok || !r.jobId) return failToast(t('rt.scanFail'), r);
    showJob(r.jobId, {title: t('rt.scanJob'), icon: 'radar', closeOnDone: true, onFinal: () => refreshNow()});
    refreshSoon();
  }

  /* ===================== DB Move page ===================== */
  const MOVE_STAGE_COUNT = 5; // Jaanch → Dump → Import → Milan → Mukammal (labels: mv.stage0..4)
  const DB_NAME_RE = /^[A-Za-z0-9_$-]{1,64}$/;
  const M = {
    fromId: '', fromDb: '', toId: '', toDb: '', toDbTouched: false, projectId: '',
    creds: {from: {user: '', password: ''}, to: {user: '', password: ''}},
    dbs: null, jobId: null, job: null, ctx: null, envDone: false, dumpDeleted: false
  };
  const MV = {};
  pageImpl.move = {mount: mountMove, update: updateMove, unmount() { for (const k of Object.keys(MV)) delete MV[k]; }};

  function credInput(side, key, label) {
    const input = h('input', {
      class: 'input', type: key === 'password' ? 'password' : 'text', autocomplete: key === 'password' ? 'new-password' : 'off',
      spellcheck: 'false', placeholder: key === 'user' ? 'root' : t('mv.emptyPh'), 'aria-label': label, value: M.creds[side][key],
      dataset: {bind: side + '.' + key}
    });
    input.addEventListener('input', () => {
      M.creds[side][key] = input.value;
      for (const other of document.querySelectorAll('[data-bind="' + side + '.' + key + '"]')) if (other !== input) other.value = input.value;
    });
    return input;
  }
  function credField(label, input) {
    return h('div', {class: 'field'}, h('span', {class: 'field-label'}, label), input);
  }

  function mountMove(root) {
    MV.fromSel = h('select', {class: 'select', id: 'mv-from'});
    MV.fromSel.addEventListener('change', () => {
      M.fromId = MV.fromSel.value;
      M.fromDb = '';
      loadSourceDbs();
      validateMove();
    });
    MV.dbSel = h('select', {class: 'select', id: 'mv-db'});
    MV.dbSel.addEventListener('change', () => {
      M.fromDb = MV.dbSel.value;
      if (!M.toDbTouched) { M.toDb = M.fromDb; MV.toDbInput.value = M.toDb; }
      validateMove();
    });
    MV.dbStatus = h('div', {class: 'step-extra'});
    MV.toSel = h('select', {class: 'select', id: 'mv-to'});
    MV.toSel.addEventListener('change', () => { M.toId = MV.toSel.value; validateMove(); });
    MV.toDbInput = h('input', {class: 'input mono', id: 'mv-todb', type: 'text', value: M.toDb, autocomplete: 'off', spellcheck: 'false', placeholder: t('mv.toDbPh')});
    MV.toDbInput.addEventListener('input', () => {
      M.toDb = MV.toDbInput.value.trim();
      M.toDbTouched = M.toDb !== '' && M.toDb !== M.fromDb;
      validateMove();
    });
    MV.toDbErr = h('div', {class: 'field-error', 'aria-live': 'polite'});
    MV.projSel = h('select', {class: 'select', id: 'mv-proj'});
    MV.projSel.addEventListener('change', onMoveProjectChange);
    MV.login = h('details', {class: 'login-box'},
      h('summary', null, icon('key'), t('mv.loginSummary'), icon('chevron-down', 'chev')),
      h('div', {class: 'login-cols'},
        h('div', {class: 'login-col'}, h('h4', null, t('mv.oldServer')),
          credField(t('cred.user'), credInput('from', 'user', t('mv.oldUserAria'))),
          credField(t('cred.password'), credInput('from', 'password', t('mv.oldPassAria')))),
        h('div', {class: 'login-col'}, h('h4', null, t('mv.newServer')),
          credField(t('cred.user'), credInput('to', 'user', t('mv.newUserAria'))),
          credField(t('cred.password'), credInput('to', 'password', t('mv.newPassAria'))))),
      h('p', {class: 'field-hint login-note'}, t('mv.loginNote')));
    MV.startBtn = btn(t('mv.start'), {kind: 'primary', icon: 'move', onClick: () => startMove()});
    MV.hint = h('span', {class: 'muted small', 'aria-live': 'polite'});
    MV.formErr = h('div', {class: 'field-error', 'aria-live': 'polite'});
    MV.noServers = h('div');
    MV.progress = h('div');
    const step = (n, title, sub, ...content) => h('section', {class: 'panel step-card', 'aria-label': title},
      h('div', {class: 'step-card-head'}, h('span', {class: 'step-num', 'aria-hidden': 'true'}, String(n)),
        h('div', null, h('h2', {class: 'step-card-title'}, title), h('p', {class: 'step-card-sub'}, sub))),
      ...content);
    root.append(
      h('div', {class: 'move-intro'}, callout('info', t('mv.noOverwrite'), t('mv.noOverwriteText'))),
      MV.noServers,
      h('div', {class: 'move-layout'},
        h('div', {class: 'move-steps'},
          step(1, t('mv.oldServer'), t('mv.step1Sub'),
            h('div', {class: 'form-grid'}, field(t('mv.server'), MV.fromSel), field(t('common.database'), MV.dbSel)), MV.dbStatus),
          step(2, t('mv.newServer'), t('mv.step2Sub'),
            h('div', {class: 'form-grid'}, field(t('mv.server'), MV.toSel),
              h('div', {class: 'field'}, h('label', {class: 'field-label', for: 'mv-todb'}, t('mv.newName')), MV.toDbInput, MV.toDbErr))),
          step(3, t('mv.step3'), t('mv.step3Sub'),
            field(t('common.project'), MV.projSel)),
          MV.login,
          h('div', {class: 'move-actions'}, MV.startBtn, MV.hint),
          MV.formErr),
        MV.progress));
    fillMoveSelects(true);
    fillDbSelect();
    renderDbStatus();
    renderProgress();
    validateMove();
  }

  function updateMove() {
    if (!MV.fromSel) return;
    fillMoveSelects(false);
    renderProgress();
    validateMove();
  }

  function fillServerSelect(sel, value, force) {
    if (!force && document.activeElement === sel) return;
    const servers = S.state.dbServers;
    const sig = JSON.stringify(servers.map((d) => [d.id, serverName(d), d.port, d.status])) + '|' + value;
    if (!force && sel.__dpSig === sig) return;
    sel.__dpSig = sig;
    sel.replaceChildren(h('option', {value: ''}, t('mv.chooseServer')));
    for (const d of servers) {
      const on = d.status === 'running';
      const opt = h('option', {value: d.id}, serverName(d) + ' · :' + d.port + (on ? '' : ' ' + t('mv.stoppedSuffix')));
      opt.disabled = !on && d.id !== value;
      sel.appendChild(opt);
    }
    sel.value = value && servers.some((d) => d.id === value) ? value : '';
  }
  function fillMoveSelects(force) {
    fillServerSelect(MV.fromSel, M.fromId, force);
    fillServerSelect(MV.toSel, M.toId, force);
    if (force || document.activeElement !== MV.projSel) {
      const sig = JSON.stringify(S.state.projects.map((p) => [p.id, p.name])) + '|' + M.projectId;
      if (force || MV.projSel.__dpSig !== sig) {
        MV.projSel.__dpSig = sig;
        MV.projSel.replaceChildren(h('option', {value: ''}, t('common.none')), ...S.state.projects.map((p) => h('option', {value: p.id}, p.name)));
        MV.projSel.value = findProject(M.projectId) ? M.projectId : '';
      }
    }
    const running = S.state.dbServers.filter((d) => d.status === 'running').length;
    patchSection(MV.noServers, running ? 'ok' : 'none', () => (running ? null : callout('warn', t('live.dbNone'),
      t('mv.noRunningText'),
      [btn(t('mv.openDb'), {size: 'sm', icon: 'db', onClick: () => goPage('db')})])));
  }
  function fillDbSelect() {
    const sel = MV.dbSel;
    if (!sel || document.activeElement === sel) return;
    sel.replaceChildren();
    const st = M.dbs;
    if (!M.fromId) { sel.appendChild(h('option', {value: ''}, t('mv.chooseServerFirst'))); sel.disabled = true; return; }
    if (!st || st.loading) { sel.appendChild(h('option', {value: ''}, t('common.listLoading'))); sel.disabled = true; return; }
    if (!st.items) { sel.appendChild(h('option', {value: ''}, st.need ? t('mv.needLogin') : t('mv.noList'))); sel.disabled = true; return; }
    sel.disabled = false;
    sel.appendChild(h('option', {value: ''}, st.items.length ? t('mv.chooseDb') : t('mv.noDbs')));
    for (const x of st.items) sel.appendChild(h('option', {value: x.name}, x.name + (x.sizeMB != null ? ' · ' + fmtMB(x.sizeMB) : '')));
    sel.value = st.items.some((x) => x.name === M.fromDb) ? M.fromDb : '';
  }
  function renderDbStatus() {
    if (!MV.dbStatus) return;
    const st = M.dbs;
    let content = null;
    if (M.fromId && st && st.loading) {
      content = h('div', {class: 'row muted small'}, spinner(), t('mv.dbsLoading'));
    } else if (st && st.need) {
      content = callout('warn', t('mv.needLogin'), h('div', {class: 'stack'},
        h('span', null, t('mv.loginText')),
        h('div', {class: 'inline-creds'},
          credField(t('cred.user'), credInput('from', 'user', t('mv.oldUserAria'))),
          credField(t('cred.password'), credInput('from', 'password', t('mv.oldPassAria'))),
          btn(t('mv.reload'), {icon: 'refresh', onClick: () => loadSourceDbs()}))));
    } else if (st && st.error) {
      content = callout('bad', null, st.error, [btn(t('common.retry'), {size: 'sm', icon: 'refresh', onClick: () => loadSourceDbs()})]);
    }
    MV.dbStatus.replaceChildren(...(content ? [content] : []));
  }
  async function loadSourceDbs() {
    const sid = M.fromId;
    if (!sid) { M.dbs = null; fillDbSelect(); renderDbStatus(); return; }
    M.dbs = {serverId: sid, loading: true};
    fillDbSelect();
    renderDbStatus();
    const body = {};
    if (M.creds.from.user.trim()) { body.user = M.creds.from.user.trim(); body.password = M.creds.from.password; }
    if (M.projectId) body.projectId = M.projectId;
    const r = await api('POST', '/api/db/' + enc(sid) + '/databases', body);
    if (M.fromId !== sid) return;
    if (r.ok) {
      const items = arr(r.databases);
      M.dbs = {serverId: sid, items};
      if (!items.some((x) => x.name === M.fromDb)) {
        const p = findProject(M.projectId);
        const envDb = p && p.info && p.info.env ? p.info.env.database : null;
        M.fromDb = envDb && items.some((x) => x.name === envDb) ? envDb : '';
      }
      if (!M.toDbTouched) { M.toDb = M.fromDb; if (MV.toDbInput) MV.toDbInput.value = M.toDb; }
    } else if (r.code === 'NEED_CREDENTIALS') {
      M.dbs = {serverId: sid, need: true};
    } else {
      M.dbs = {serverId: sid, error: errorText(r)};
    }
    fillDbSelect();
    renderDbStatus();
    validateMove();
  }
  function onMoveProjectChange() {
    M.projectId = MV.projSel.value;
    const p = findProject(M.projectId);
    if (p && p.dbServerId && !M.fromId) {
      const d = findServer(p.dbServerId);
      if (d && d.status === 'running') { M.fromId = d.id; fillServerSelect(MV.fromSel, M.fromId, true); }
    }
    if (M.fromId && (!M.dbs || !M.dbs.items)) {
      loadSourceDbs();
    } else if (p && M.dbs && M.dbs.items && !M.fromDb) {
      const envDb = p.info && p.info.env ? p.info.env.database : null;
      if (envDb && M.dbs.items.some((x) => x.name === envDb)) {
        M.fromDb = envDb;
        fillDbSelect();
        if (!M.toDbTouched) { M.toDb = envDb; MV.toDbInput.value = envDb; }
      }
    }
    validateMove();
  }
  function moveIsRunning() { return !!M.jobId && (!M.job || M.job.status === 'running'); }
  function validateMove() {
    if (!MV.startBtn) return null;
    const from = findServer(M.fromId);
    const to = findServer(M.toId);
    let nameErr = '';
    if (M.toDb && !DB_NAME_RE.test(M.toDb)) nameErr = t('mv.nameInvalid');
    else if (M.fromId && M.fromId === M.toId && M.fromDb && M.toDb === M.fromDb) nameErr = t('mv.sameName');
    MV.toDbErr.textContent = nameErr;
    MV.toDbInput.classList.toggle('is-invalid', !!nameErr);
    let problem = null;
    if (!from) problem = t('mv.pFrom');
    else if (from.status !== 'running') problem = t('mv.pFromStopped');
    else if (!M.fromDb) problem = t('mv.pFromDb');
    else if (!to) problem = t('mv.pTo');
    else if (to.status !== 'running') problem = t('mv.pToStopped');
    else if (!M.toDb) problem = t('mv.pToDb');
    else if (nameErr) problem = nameErr;
    const running = moveIsRunning();
    if (!MV.startBtn.classList.contains('is-busy')) MV.startBtn.disabled = !!problem || running;
    MV.hint.textContent = running ? t('mv.running') : problem || t('mv.ready');
    return problem;
  }

  async function startMove() {
    MV.formErr.textContent = '';
    const problem = validateMove();
    if (problem) { MV.formErr.textContent = problem; return; }
    const from = findServer(M.fromId);
    const to = findServer(M.toId);
    const proj = findProject(M.projectId);
    const yes = await confirmDialog({
      title: t('mv.q'), icon: 'move', tone: 'warn', size: 'md',
      message: t('mv.qMsg'),
      details: h('div', {class: 'stack'},
        kvList([[t('mv.old'), serverName(from) + ' :' + from.port + ' / ' + M.fromDb], [t('mv.new'), serverName(to) + ' :' + to.port + ' / ' + M.toDb],
          proj ? [t('common.project'), t('mv.projChange', {name: proj.name})] : null]),
        callout('warn', t('mv.dumpWarnTitle'), t('mv.dumpWarnText', {dir: S.state.settings.dumpDir ? S.state.settings.dumpDir + '\\devpanel' : t('mv.dumpFolder')}))),
      confirmLabel: t('mv.yes'), confirmIcon: 'play'
    });
    if (!yes) return;
    const body = {fromServerId: M.fromId, fromDb: M.fromDb, toServerId: M.toId, toDb: M.toDb};
    if (M.creds.from.user.trim()) body.from = {user: M.creds.from.user.trim(), password: M.creds.from.password};
    if (M.creds.to.user.trim()) body.to = {user: M.creds.to.user.trim(), password: M.creds.to.password};
    if (M.projectId) body.projectId = M.projectId;
    setBusy(MV.startBtn, true, t('common.startingShort'));
    const r = await api('POST', '/api/dbmove', body);
    if (MV.startBtn) setBusy(MV.startBtn, false);
    if (!r.ok || !r.jobId) {
      if (r.code === 'NEED_CREDENTIALS' && MV.login) MV.login.open = true;
      if (MV.formErr) MV.formErr.textContent = errorText(r);
      validateMove();
      return;
    }
    const jobId = r.jobId;
    M.jobId = jobId;
    M.job = null;
    M.envDone = false;
    M.dumpDeleted = false;
    M.ctx = {
      fromName: serverName(from), fromPort: from.port, fromDb: M.fromDb,
      toId: to.id, toName: serverName(to), toPort: to.port, toDb: M.toDb, projectId: M.projectId || null
    };
    renderProgress();
    validateMove();
    const w = watchJob(jobId);
    const onUpdate = (job) => { if (M.jobId === jobId) { M.job = job; renderProgress(); } };
    w.listeners.add(onUpdate);
    w.done.then((job) => {
      w.listeners.delete(onUpdate);
      if (M.jobId !== jobId) return;
      M.job = job;
      renderProgress();
      validateMove();
      if (job.status === 'done') {
        toast('success', t('mv.done'), M.ctx.fromDb + ' → ' + M.ctx.toDb + ' (' + M.ctx.toName + ')');
        M.creds.from.password = '';
        M.creds.to.password = '';
        for (const el of document.querySelectorAll('[data-bind$=".password"]')) el.value = '';
      } else {
        toast('error', t('mv.failed'), jobErrorText(job), {duration: 9000});
      }
    });
  }

  function moveStage(job) {
    if (!job) return 0;
    if (job.status === 'done') return 4;
    let stage = typeof job.stage === 'number' ? Math.min(3, Math.max(0, job.stage)) : 0;
    for (const s of arr(job.steps)) {
      const txt = String((s && s.text) || '').toLowerCase();
      let st = 0;
      if (/milan|muqabla|tulna|compare|verify|ملان|موازنہ/.test(txt)) st = 3;
      else if (/import|create database|امپورٹ/.test(txt)) st = 2;
      else if (/dump|ڈمپ/.test(txt)) st = 1;
      if (st > stage) stage = st;
    }
    return stage;
  }
  function pipelineView(job) {
    const stage = moveStage(job);
    const failed = job && job.status === 'failed';
    const stages = [];
    for (let i = 0; i < MOVE_STAGE_COUNT; i++) stages.push(t('mv.stage' + i));
    return h('ol', {class: 'pipeline', 'aria-label': t('mv.stagesAria')}, stages.map((label, i) => {
      const done = !!job && (job.status === 'done' || i < stage);
      const active = !!job && job.status === 'running' && i === stage;
      const bad = failed && i === stage;
      return h('li', {class: ['pstep', done && 'is-done', active && 'is-active', bad && 'is-failed'], 'aria-current': active ? 'step' : null},
        h('span', {class: 'pstep-dot'}, done ? icon('check') : bad ? icon('x') : active ? spinner() : String(i + 1)), label);
    }));
  }
  function dumpSizeText(job) {
    if (!job) return '';
    const pr = job.progress || {};
    const res = job.result || {};
    if (pr.dumpBytes != null) return fmtBytes(pr.dumpBytes);
    if (res.dumpBytes != null) return fmtBytes(res.dumpBytes);
    if (res.dumpSize != null) return typeof res.dumpSize === 'number' ? fmtBytes(res.dumpSize) : String(res.dumpSize);
    const steps = arr(job.steps);
    for (let i = steps.length - 1; i >= 0; i--) {
      const txt = String((steps[i] && steps[i].text) || '');
      const m = /(\d+(?:\.\d+)?\s?(?:KB|MB|GB|bytes))\b/i.exec(txt);
      if (m && /dump|ڈمپ/i.test(txt)) return m[1];
    }
    return '';
  }
  function normalizeTableRows(res) {
    const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };
    const diffNames = new Set(arr(res.diff).map((d) => d && (d.table || d.name)).filter(Boolean));
    let list = [];
    const src = Array.isArray(res.tables) ? res.tables : Array.isArray(res.perTable) ? res.perTable : Array.isArray(res.tableCounts) ? res.tableCounts : null;
    if (src) {
      list = src.map((x) => (typeof x === 'object' && x ? {
        name: pick(x, ['name', 'table']), from: pick(x, ['source', 'from', 'old', 'before', 'sourceRows']), to: pick(x, ['target', 'to', 'new', 'after', 'targetRows'])
      } : {name: String(x), from: null, to: null}));
    } else if (res.tables && typeof res.tables === 'object') {
      list = Object.keys(res.tables).map((k) => {
        const v = res.tables[k];
        return typeof v === 'object' && v ? {name: k, from: pick(v, ['source', 'from', 'old', 'before']), to: pick(v, ['target', 'to', 'new', 'after'])} : {name: k, from: v, to: null};
      });
    }
    for (const r of list) r.mismatch = diffNames.has(r.name) || (r.from != null && r.to != null && Number(r.from) !== Number(r.to));
    return list.filter((r) => r.name != null);
  }
  function tableCountsView(rows) {
    const bad = rows.filter((r) => r.mismatch).length;
    return h('div', {class: 'stack'},
      bad ? chip(tn('mv.tablesDiff', bad), {kind: 'bad', icon: 'alert'}) : null,
      h('div', {class: 'table-wrap move-table'}, h('table', {class: 'table'},
        h('thead', null, h('tr', null, h('th', null, t('mv.table')), h('th', {class: 'num'}, t('mv.oldRows')), h('th', {class: 'num'}, t('mv.newRows')))),
        h('tbody', null, rows.map((r) => h('tr', {class: r.mismatch ? 'is-mismatch' : null},
          h('td', {class: 'mono'}, String(r.name)), h('td', {class: 'num'}, r.from == null ? '-' : fmtInt(r.from)), h('td', {class: 'num'}, r.to == null ? '-' : fmtInt(r.to))))))));
  }
  function diffView(diff) {
    return h('div', {class: 'table-wrap move-table'}, h('table', {class: 'table'},
      h('thead', null, h('tr', null, h('th', null, t('mv.diff')), h('th', {class: 'num'}, t('mv.old')), h('th', {class: 'num'}, t('mv.new')))),
      h('tbody', null, diff.map((d) => h('tr', {class: 'is-mismatch'},
        h('td', {class: 'mono'}, String((d && (d.table || d.name || d.what || d.kind)) || (typeof d === 'string' ? d : '-'))),
        h('td', {class: 'num'}, d && d.source != null ? fmtInt(d.source) : d && d.from != null ? fmtInt(d.from) : '-'),
        h('td', {class: 'num'}, d && d.target != null ? fmtInt(d.target) : d && d.to != null ? fmtInt(d.to) : '-'))))));
  }
  function moveResultView(job) {
    const res = job.result && typeof job.result === 'object' ? job.result : {};
    const out = [];
    const rows = normalizeTableRows(res);
    if (job.status === 'done') {
      const totalRows = typeof res.rows === 'number' ? res.rows : rows.reduce((a, r) => a + (Number(r.to) || 0), 0);
      const tableCount = typeof res.tables === 'number' ? res.tables : rows.length;
      out.push(callout('ok', t('mv.okTitle'), h('div', {class: 'result-summary'},
        chip(tn('mv.tablesN', tableCount, {n: fmtInt(tableCount)}), {kind: 'ok', icon: 'list'}), chip(tn('mv.rowsN', totalRows, {n: fmtInt(totalRows)}), {kind: 'ok', icon: 'db'}))));
    } else {
      out.push(callout('bad', t('mv.failTitle'), jobErrorText(job)));
    }
    if (rows.length) out.push(tableCountsView(rows));
    else if (arr(res.diff).length) out.push(diffView(arr(res.diff)));
    if (res.dumpFile) {
      out.push(callout('warn', t('mv.dumpHasData'), h('div', {class: 'stack'},
        h('div', {class: 'pc-path'}, h('code', {class: 'break'}, res.dumpFile), copyButton(res.dumpFile, t('mv.copyDump'))),
        M.dumpDeleted ? h('span', {class: 'yes'}, t('mv.dumpDeleted')) : null),
        M.dumpDeleted ? [] : [btn(t('mv.deleteDump'), {size: 'sm', kind: 'soft-danger', icon: 'trash', onClick: (ev) => deleteDump(res.dumpFile, ev.currentTarget)})]));
    } else {
      out.push(callout('warn', null, t('mv.dumpNote')));
    }
    const p = job.status === 'done' && M.ctx && M.ctx.projectId ? findProject(M.ctx.projectId) : null;
    if (p) {
      const env = (p.info && p.info.env) || {};
      const portDiffers = String(env.port || '') !== String(M.ctx.toPort);
      const dbDiffers = (env.database || '') !== M.ctx.toDb;
      if (M.envDone) {
        out.push(callout('ok', null, t('mv.envDone', {name: p.name})));
      } else if (portDiffers || dbDiffers) {
        const what = [portDiffers ? 'DB_PORT=' + M.ctx.toPort : null, dbDiffers ? 'DB_DATABASE=' + M.ctx.toDb : null].filter(Boolean).join(' ' + t('mv.and') + ' ');
        out.push(callout('info', t('mv.projTitle', {name: p.name}), t('mv.envPending', {what}),
          [btn(t('mv.envBtn'), {size: 'sm', kind: 'primary', icon: 'pencil', onClick: (ev) => moveWriteEnv(p, dbDiffers, ev.currentTarget)})]));
      }
    }
    out.push(h('div', {class: 'move-actions'}, btn(t('mv.newMove'), {icon: 'plus', onClick: () => resetMove()})));
    return out;
  }

  function renderProgress() {
    if (!MV.progress) return;
    if (!M.jobId) {
      patchSection(MV.progress, 'idle', () => h('section', {class: 'panel', 'aria-label': t('mv.how')},
        h('div', {class: 'panel-head'}, h('h2', {class: 'panel-title'}, icon('move'), t('mv.how'))),
        h('div', {class: 'panel-body stack'}, pipelineView(null),
          h('ol', {class: 'next-list'}, [1, 2, 3, 4, 5].map((i) => h('li', null, t('mv.how' + i)))))));
      return;
    }
    const job = M.job;
    if (MV.progress.__dpSig !== 'job:' + M.jobId) {
      MV.progress.__dpSig = 'job:' + M.jobId;
      MV.pChip = h('span');
      MV.pPipe = h('div');
      MV.pDump = h('div', {class: 'row small'});
      MV.pSteps = h('ol', {class: 'steps', dataset: {empty: t('job.starting')}, 'aria-live': 'polite', 'aria-label': t('mv.logAria')});
      MV.pResult = h('div', {class: 'stack'});
      const c = M.ctx;
      MV.progress.replaceChildren(h('section', {class: 'panel', 'aria-label': t('mv.status')},
        h('div', {class: 'panel-head'}, h('h2', {class: 'panel-title'}, icon('move'), t('mv.status')), h('span', {class: 'spacer'}), MV.pChip),
        h('div', {class: 'panel-body stack'},
          h('div', {class: 'row small move-route'}, chip(c.fromName + ' :' + c.fromPort, {}), h('span', {class: 'mono'}, c.fromDb), icon('arrow'),
            chip(c.toName + ' :' + c.toPort, {kind: 'accent'}), h('span', {class: 'mono'}, c.toDb)),
          MV.pPipe, MV.pDump, MV.pSteps, MV.pResult)));
    }
    const status = job ? job.status : 'running';
    if (MV.pChip.__dpSig !== status) { MV.pChip.__dpSig = status; MV.pChip.replaceChildren(statusChip(job)); }
    const pipeSig = status + ':' + moveStage(job);
    if (MV.pPipe.__dpSig !== pipeSig) { MV.pPipe.__dpSig = pipeSig; MV.pPipe.replaceChildren(pipelineView(job || {status: 'running', steps: []})); }
    const size = dumpSizeText(job);
    patchSection(MV.pDump, size, () => (size ? [icon('download'), h('span', null, t('mv.dumpSize')), h('span', {class: 'dump-size'}, size)] : null));
    syncSteps(MV.pSteps, arr(job && job.steps));
    if (job && job.status !== 'running') {
      const p = M.ctx.projectId ? findProject(M.ctx.projectId) : null;
      const rsig = job.status + '|' + M.envDone + '|' + M.dumpDeleted + '|' + JSON.stringify(p && p.info ? p.info.env : null);
      patchSection(MV.pResult, rsig, () => moveResultView(job));
    }
  }
  async function moveWriteEnv(p, dbDiffers, b) {
    const body = {port: Number(M.ctx.toPort)};
    if (dbDiffers) body.database = M.ctx.toDb;
    const what = 'DB_PORT=' + body.port + (body.database ? ' ' + t('mv.and') + ' DB_DATABASE=' + body.database : '');
    const yes = await confirmDialog({
      title: t('mv.envQ'), icon: 'pencil', tone: 'warn', size: 'md',
      message: t('mv.envMsg', {name: p.name, what}),
      details: callout('info', t('env.backupTitle'), t('mv.envBackup')),
      confirmLabel: t('mv.envYes'), confirmIcon: 'check'
    });
    if (!yes) return;
    setBusy(b, true);
    const r = await api('POST', '/api/projects/' + enc(p.id) + '/write-env-db', body);
    setBusy(b, false);
    if (!r.ok) return failToast(t('env.fail'), r);
    M.envDone = true;
    toast('success', t('env.done'), r.backup ? t('env.backup', {path: r.backup}) : null, {duration: 8000});
    renderProgress();
    refreshSoon();
  }
  async function deleteDump(file, b) {
    const yes = await confirmDialog({
      title: t('mv.delQ'), danger: true, icon: 'trash',
      message: t('mv.delMsg'), details: h('code', {class: 'break'}, file), confirmLabel: t('mv.delYes')
    });
    if (!yes) return;
    setBusy(b, true);
    const r = await api('POST', '/api/dumps/delete', {file});
    setBusy(b, false);
    if (!r.ok) return failToast(t('mv.delFail'), r);
    M.dumpDeleted = true;
    toast('success', t('mv.delDone'));
    renderProgress();
  }
  function resetMove() {
    M.jobId = null;
    M.job = null;
    M.ctx = null;
    M.envDone = false;
    M.dumpDeleted = false;
    if (MV.progress) MV.progress.__dpSig = null;
    renderProgress();
    if (M.fromId) loadSourceDbs();
    validateMove();
  }

  /* ===================== Runtimes page ===================== */
  const RT = {openExt: new Set()};
  pageImpl.runtimes = {mount: mountRuntimes, update: updateRuntimes};
  const SOURCE_LABEL = {xampp: 'XAMPP', laragon: 'Laragon', path: 'PATH'};
  function sourceLabel(s) { return SOURCE_LABEL[s] || (hasT('src.' + s) ? t('src.' + s) : (s || '-')); }

  function mountRuntimes(root) {
    RT.meta = h('span', {class: 'muted small'});
    RT.banner = h('div');
    RT.php = h('div');
    RT.composer = h('div');
    RT.db = h('div');
    root.append(
      h('div', {class: 'toolbar'},
        btn(t('rt.rescan'), {kind: 'primary', icon: 'radar', onClick: (ev) => startScan(ev.currentTarget)}),
        btn(t('rt.addPath'), {icon: 'plus', onClick: () => openAddRuntime()}),
        h('span', {class: 'spacer'}), RT.meta),
      RT.banner, RT.php, RT.composer, RT.db);
  }
  function updateRuntimes(st) {
    if (!RT.php) return;
    const rt = st.runtimes;
    patchSection(RT.meta, String(rt.scannedAt), () => (rt.scannedAt
      ? h('span', {dataset: {since: rt.scannedAt, mode: 'ago', tpl: 'rt.lastScan'}}, t('rt.lastScan', {d: agoText(rt.scannedAt)}))
      : t('rt.notScanned')));
    patchSection(RT.banner, String(rt.scanning), () => (rt.scanning
      ? h('div', {class: 'section-gap'}, callout('info', t('rt.scanning'), t('rt.scanningText')))
      : null));
    patchSection(RT.php, JSON.stringify(rt.php), () => phpSection(rt.php));
    patchSection(RT.composer, JSON.stringify(rt.composer), () => composerSection(rt.composer));
    patchSection(RT.db, JSON.stringify(rt.db), () => dbInstallSection(rt.db));
  }
  function rtPanel(iconName, title, count, sub, content) {
    return h('section', {class: 'panel', 'aria-label': title},
      h('div', {class: 'panel-head'}, h('h2', {class: 'panel-title'}, icon(iconName), title), chip(String(count), {}), h('span', {class: 'panel-sub'}, sub)),
      content);
  }
  function headRow(labels) { return h('thead', null, h('tr', null, labels.map((x) => h('th', null, x)))); }
  function phpSection(list) {
    const sub = t('rt.phpSub');
    if (!list.length) {
      return rtPanel('code', 'PHP', 0, sub, h('div', {class: 'panel-body'}, emptyState({small: true, icon: 'cpu', title: t('rt.noPhp'),
        text: t('rt.noPhpText')})));
    }
    const rows = list.slice().sort((a, b) => compareVer(b.version, a.version)).map((r) => {
      const ini = r.iniRelocated
        ? chip(t('rt.relocated'), {kind: 'info', icon: 'info', title: t('rt.relocatedTitle') + (r.iniFile ? ': ' + r.iniFile : '.')})
        : r.iniFile ? chip(t('rt.iniOk'), {kind: 'ok', icon: 'check', title: r.iniFile}) : chip(t('rt.noIni'), {kind: 'warn', title: t('rt.noIniTitle')});
      const exts = arr(r.extensions).slice().sort();
      let extCell = h('span', {class: 'muted'}, '-');
      if (exts.length) {
        const det = h('details', {class: 'ext-details'},
          h('summary', null, icon('chevron-right'), tn('rt.ext', exts.length)),
          h('div', {class: 'ext-chip-list', dir: 'ltr'}, exts.map((e) => chip(e, {}))));
        if (RT.openExt.has(r.id)) det.open = true;
        det.addEventListener('toggle', () => { if (det.open) RT.openExt.add(r.id); else RT.openExt.delete(r.id); });
        extCell = det;
      }
      const warns = arr(r.warnings);
      return h('tr', null,
        h('td', null, chip('PHP ' + (r.version || '?'), {fam: famClass(r.version)}), r.ok ? null : h('div', {class: 'cell-err'}, r.error || t('rt.phpBroken'))),
        h('td', null, h('div', {class: 'cell-path'}, r.path), warns.length ? h('div', {class: 'cell-warn'}, warns.slice(0, 5).join('\n')) : null),
        h('td', null, r.zts ? 'ZTS' : 'NTS'),
        h('td', {class: 'num'}, r.bits ? h('span', {class: 'ltr'}, r.bits + '-bit') : '-'),
        h('td', null, ini),
        h('td', null, extCell),
        h('td', null, chip(sourceLabel(r.source), {})));
    });
    return rtPanel('code', 'PHP', list.length, sub, h('div', {class: 'table-wrap'}, h('table', {class: 'table'},
      headRow([t('th.version'), t('th.path'), t('th.thread'), t('th.bits'), 'php.ini', t('th.extensions'), t('th.source')]),
      h('tbody', null, rows))));
  }
  function composerSection(list) {
    const sub = t('rt.compSub');
    if (!list.length) {
      return rtPanel('download', 'Composer', 0, sub, h('div', {class: 'panel-body'}, emptyState({small: true, icon: 'download', title: t('rt.noComp'),
        text: t('rt.noCompText')})));
    }
    const byCid = new Map(list.map((c) => [c.id, c]));
    const rows = list.slice().sort((a, b) => compareVer(b.version, a.version)).map((c) => {
      const same = c.sameAs ? byCid.get(c.sameAs) : null;
      return h('tr', null,
        h('td', null, chip('Composer ' + (c.version || '?'), {cls: 'chip-ver chip-composer'}), c.ok ? null : h('div', {class: 'cell-err'}, c.error || t('rt.compBroken'))),
        h('td', null, h('div', {class: 'cell-path'}, c.path)),
        h('td', null, same ? h('span', {class: 'small'}, t('rt.sameCopy') + ' ', h('span', {class: 'cell-path'}, same.path)) : h('span', {class: 'muted'}, '-')));
    });
    return rtPanel('download', 'Composer', list.length, sub, h('div', {class: 'table-wrap'}, h('table', {class: 'table'},
      headRow([t('th.version'), t('th.path'), t('th.sameAs')]),
      h('tbody', null, rows))));
  }
  function toolMark(name, present) {
    return h('span', {class: present ? 'yes' : 'no', title: present ? String(present) : t('rt.notFound')}, (present ? '✓ ' : '✗ ') + name);
  }
  function dbInstallSection(list) {
    const sub = t('rt.dbSub');
    if (!list.length) {
      return rtPanel('db', t('rt.dbInstalls'), 0, sub, h('div', {class: 'panel-body'}, emptyState({small: true, icon: 'db', title: t('rt.noDb'),
        text: t('rt.noDbText')})));
    }
    const rows = list.slice().sort((a, b) => compareVer(b.version, a.version)).map((x) => h('tr', null,
      h('td', null, chip(dbKindLabel(x.kind) + ' ' + (x.version || '?'), {cls: 'chip-ver ' + (String(x.kind || '').toLowerCase() === 'mysql' ? 'chip-mysql' : 'chip-mariadb')}),
        x.ok === false ? h('div', {class: 'cell-err'}, x.error || t('rt.dbBroken')) : null),
      h('td', null, x.serverExe ? h('div', {class: 'cell-path'}, x.serverExe) : chip(t('rt.clientOnly'), {kind: 'info'})),
      h('td', null, h('div', {class: 'cell-path'}, x.defaultsFile || '-')),
      h('td', {class: 'num mono'}, x.port ? ':' + x.port : '-'),
      h('td', null, h('div', {class: 'cell-path'}, x.datadir || '-')),
      h('td', null, h('div', {class: 'tool-marks', dir: 'ltr'}, toolMark('client', x.client), toolMark('dump', x.dump), toolMark('admin', x.admin), toolMark('install-db', x.installDb)))));
    return rtPanel('db', t('rt.dbInstalls'), list.length, sub, h('div', {class: 'table-wrap'}, h('table', {class: 'table'},
      headRow([t('th.version'), t('th.serverExe'), 'my.ini', t('common.port'), 'Datadir', t('th.tools')]),
      h('tbody', null, rows))));
  }
  async function openAddRuntime() {
    const v = await promptDialog({
      title: t('rt.addPath'), icon: 'plus', label: t('rt.addLabel'), mono: true,
      placeholder: 'C:\\php-8.4\\php.exe',
      hint: t('rt.addHint'),
      validate: (x) => validateWinPath(x) || (/\\?(php\.exe|[^\\/]*\.phar|mysqld\.exe|mariadbd\.exe)$/i.test(x) ? null : t('rt.addInvalid')),
      confirmLabel: t('rt.addBtn')
    });
    if (v == null) return;
    const r = await api('POST', '/api/runtimes/add', {path: v});
    if (!r.ok || !r.jobId) return failToast(t('rt.addFail'), r);
    showJob(r.jobId, {title: t('rt.scanJob'), icon: 'radar', closeOnDone: true, onFinal: () => refreshNow()});
  }

  /* ===================== Install / Setup page ===================== */
  // Data lives in IN (survives page switches); view nodes in INV (dropped on unmount).
  const IN = {sys: null, cat: {}, jobs: {}, showAll: {}, scanAt: undefined};
  const INV = {};
  const CATALOG_KINDS = [
    {kind: 'php', icon: 'code', title: 'PHP', host: 'windows.php.net'},
    {kind: 'mariadb', icon: 'db', title: 'MariaDB', host: 'downloads.mariadb.org'},
    {kind: 'composer', icon: 'package', title: 'Composer', host: 'getcomposer.org'},
    {kind: 'phpmyadmin', icon: 'globe', title: 'phpMyAdmin', host: 'phpmyadmin.net'},
    {kind: 'cloudflared', icon: 'share', title: 'cloudflared', host: 'github.com/cloudflare'}
  ];
  const CATALOG_PREVIEW = 6;
  pageImpl.setup = {mount: mountSetup, update: updateSetupPage, unmount() { for (const k of Object.keys(INV)) delete INV[k]; }};

  function kindTitle(kind) {
    const k = String(kind || '').toLowerCase();
    const c = CATALOG_KINDS.find((x) => x.kind === k);
    return c ? c.title : k === 'mysql' ? 'MySQL' : k === 'node' ? 'Node.js' : (kind || '?');
  }
  function verOf(x) { return x && typeof x === 'object' ? (x.version || x.label || '') : String(x == null ? '' : x); }
  function installKey(kind, version) { return kind + '@' + version; }

  function loadSystem() {
    const prev = IN.sys;
    const entry = {loading: true, data: prev ? prev.data : null, error: null};
    IN.sys = entry;
    renderSetupPage();
    return api('GET', '/api/installer/system').then((r) => {
      if (IN.sys !== entry) return r;
      entry.loading = false;
      if (r.ok) { entry.data = r; entry.error = null; } else entry.error = r;
      renderSetupPage();
      return r;
    });
  }
  function loadCatalog(kind, force) {
    const prev = IN.cat[kind];
    if (prev && prev.loading && !force) return prev.promise;
    const entry = {loading: true, data: prev ? prev.data : null, error: null};
    IN.cat[kind] = entry;
    renderSetupPage();
    entry.promise = api('GET', '/api/installer/catalog?kind=' + enc(kind)).then((r) => {
      if (IN.cat[kind] !== entry) return r;
      entry.loading = false;
      if (r.ok) { entry.data = r; entry.error = null; } else entry.error = r;
      renderSetupPage();
      // The (offline) summary names a recommended version only once a list is known: ask it again.
      const sd = IN.sys && IN.sys.data;
      if (r.ok && sd && !IN.sys.loading && arr(sd.recommended).some((x) => x && x.kind === kind && !x.version)) loadSystem();
      return r;
    });
    return entry.promise;
  }

  function mountSetup(root) {
    root.append(wizardHero());
    INV.sys = h('div', {class: 'in-summary-wrap'});
    INV.need = h('div');
    INV.cats = {};
    const catWrap = h('div', {class: 'in-cats'});
    for (const c of CATALOG_KINDS) { INV.cats[c.kind] = h('div'); catWrap.appendChild(INV.cats[c.kind]); }
    root.append(
      h('div', {class: 'toolbar'},
        btn(t('in.refresh'), {icon: 'refresh', onClick: () => { loadSystem(); for (const c of CATALOG_KINDS) loadCatalog(c.kind, true); }}),
        h('span', {class: 'spacer'}),
        h('span', {class: 'in-safety'}, icon('shield'), t('in.safety'))),
      INV.sys, INV.need,
      h('h2', {class: 'section-title'}, icon('download'), t('in.catalogs'), h('span', {class: 'spacer'}), h('span', {class: 'muted small in-cat-note'}, t('in.catalogsNote'))),
      catWrap);
    if (!IN.sys || (!IN.sys.loading && IN.sys.error)) loadSystem();
    for (const c of CATALOG_KINDS) {
      const cur = IN.cat[c.kind];
      if (!cur || (!cur.loading && cur.error)) loadCatalog(c.kind);
    }
    renderSetupPage();
  }
  function updateSetupPage(st) {
    if (!INV.sys) return;
    // A finished runtime scan changes what is installed: ask the (offline) summary again.
    const scanAt = st.runtimes.scannedAt || null;
    if (IN.scanAt !== undefined && IN.scanAt !== scanAt && IN.sys && !IN.sys.loading) loadSystem();
    IN.scanAt = scanAt;
    renderSetupPage();
  }
  function renderSetupPage() {
    if (!INV.sys || S.mountedPage !== 'setup') return;
    const sys = IN.sys || {loading: true};
    patchSection(INV.sys, JSON.stringify([lang, sys.loading, sys.data, sys.error && sys.error.code]), () => systemSummary(sys));
    patchSection(INV.need, JSON.stringify([lang, sys.data && sys.data.missing, sys.data && sys.data.recommended, sys.loading, IN.jobs]), () => needPanel(sys));
    for (const c of CATALOG_KINDS) {
      const cat = IN.cat[c.kind] || {loading: true};
      const sig = JSON.stringify([lang, cat.loading, cat.data, cat.error && [cat.error.code, cat.error.error], IN.jobs, !!IN.showAll[c.kind]]);
      patchSection(INV.cats[c.kind], sig, () => catalogPanel(c, cat));
    }
    tickTimes();
  }

  /* ----- system summary ----- */
  function sysTile(iconName, title, versions, okText, missText, extra) {
    const has = versions.length > 0;
    return h('section', {class: ['in-tile', has ? 'is-ok' : 'is-missing'], 'aria-label': title},
      h('div', {class: 'in-tile-head'},
        h('span', {class: 'in-tile-icon'}, icon(iconName)),
        h('h3', {class: 'in-tile-title'}, title),
        h('span', {class: ['dot', has ? 'dot-ok' : 'dot-warn'], 'aria-hidden': 'true'})),
      h('div', {class: 'in-tile-body'}, has
        ? h('div', {class: 'in-vers', dir: 'ltr'}, versions.map((v) => chip(v.text, {cls: v.cls || null, fam: v.fam || null, title: v.title || null})))
        : h('span', {class: 'in-none'}, missText)),
      h('div', {class: 'in-tile-foot'}, has ? okText : extra || null));
  }
  function systemSummary(sys) {
    if (!sys.data) {
      if (sys.error) {
        return callout('bad', t('in.sysFail'), errorText(sys.error), [btn(t('common.retry'), {size: 'sm', icon: 'refresh', onClick: () => loadSystem()})]);
      }
      return h('div', {class: 'in-summary'}, [0, 1, 2, 3].map(() => h('div', {class: 'in-tile sk-card', 'aria-hidden': 'true'},
        h('span', {class: 'skeleton sk-title'}), h('span', {class: 'skeleton sk-line'}), h('span', {class: 'skeleton sk-line short'}))));
    }
    const d = sys.data;
    const uniq = (list) => Array.from(new Set(arr(list).map(verOf).filter(Boolean))).sort((a, b) => compareVer(b, a));
    const php = uniq(d.php);
    const maria = uniq(d.mariadb);
    const mysql = uniq(d.mysql);
    const comp = uniq(d.composer);
    const node = d.node && typeof d.node === 'object' ? d.node : null;
    const dbVers = maria.map((v) => ({text: 'MariaDB ' + v, cls: 'chip-ver chip-mariadb'})).concat(mysql.map((v) => ({text: 'MySQL ' + v, cls: 'chip-ver chip-mysql'})));
    return h('div', {class: 'in-summary', role: 'list', 'aria-label': t('in.sysAria')},
      sysTile('code', 'PHP', php.map((v) => ({text: 'PHP ' + v, fam: famClass(v)})), tn('in.found', php.length), t('in.notFound')),
      sysTile('db', 'MariaDB / MySQL', dbVers, tn('in.found', dbVers.length), t('in.notFound')),
      sysTile('package', 'Composer', comp.map((v) => ({text: 'Composer ' + v, cls: 'chip-ver chip-composer'})), tn('in.found', comp.length), t('in.notFound')),
      sysTile('terminal', 'Node.js', node && node.version ? [{text: 'Node ' + String(node.version).replace(/^v/i, ''), title: node.path || null}] : [],
        node && node.path ? h('span', {class: 'mono in-path', title: node.path}, node.path) : t('in.nodeRuns'), t('in.notFound')));
  }

  /* ----- missing / recommended ----- */
  function needPanel(sys) {
    if (!sys.data) return null;
    const missing = arr(sys.data.missing).filter((x) => x && x.kind);
    const rec = arr(sys.data.recommended).filter((x) => x && x.kind && x.version);
    if (!missing.length && !rec.length) return h('div', {class: 'section-gap'}, callout('ok', t('in.allGood'), t('in.allGoodText')));
    const used = new Set();
    const rows = missing.map((x) => {
      const r = rec.find((y) => y.kind === x.kind && !used.has(y));
      if (r) used.add(r);
      return needRow('alert', 'warn', kindTitle(x.kind), x.reason ? bidi(String(x.reason)) : t('in.missingGeneric'), r, x.kind);
    });
    for (const r of rec) if (!used.has(r)) rows.push(needRow('sparkle', 'info', kindTitle(r.kind), t('in.recText', {what: kindTitle(r.kind) + ' ' + r.version}), r));
    return h('section', {class: 'panel in-need', 'aria-label': t('in.needTitle')},
      h('div', {class: 'panel-head'}, h('h2', {class: 'panel-title'}, icon('sparkle'), t('in.needTitle')), h('span', {class: 'panel-sub'}, t('in.needSub'))),
      h('div', {class: 'panel-body flush'}, rows));
  }
  function needRow(iconName, tone, title, text, rec, kind) {
    const key = rec ? installKey(rec.kind, rec.version) : null;
    const running = key && IN.jobs[key];
    const listKind = !rec && kind && INV.cats && INV.cats[kind] ? kind : null;
    return h('div', {class: ['in-need-row', 'is-' + tone]},
      h('span', {class: 'in-need-icon'}, icon(iconName)),
      h('div', {class: 'in-need-main'}, h('div', {class: 'in-need-title'}, title), h('div', {class: 'in-need-text'}, text)),
      rec ? h('div', {class: 'in-need-act'},
        chip(kindTitle(rec.kind) + ' ' + rec.version, {kind: 'accent', title: t('in.recommended')}),
        running
          ? btn(t('in.installing'), {size: 'sm', icon: 'clock', onClick: () => reopenInstall(rec.kind, rec.version)})
          : btn(t('in.install'), {size: 'sm', kind: 'primary', icon: 'download', onClick: (ev) => installRecommended(rec, ev.currentTarget)}))
        : listKind ? h('div', {class: 'in-need-act'}, btn(t('in.seeList'), {size: 'sm', icon: 'list', onClick: () => {
          const el = INV.cats && INV.cats[listKind];
          if (el) el.scrollIntoView({block: 'start', behavior: 'smooth'});
        }})) : null);
  }
  async function installRecommended(rec, b) {
    let cat = IN.cat[rec.kind];
    if (!cat || !cat.data) {
      setBusy(b, true);
      await loadCatalog(rec.kind);
      setBusy(b, false);
      cat = IN.cat[rec.kind];
    }
    if (!cat || !cat.data) return failToast(t('in.catFail', {what: kindTitle(rec.kind)}), (cat && cat.error) || {});
    const item = arr(cat.data.items).find((x) => x && String(x.version) === String(rec.version));
    if (!item) return toast('warn', t('in.notInList'), kindTitle(rec.kind) + ' ' + rec.version);
    openInstallConfirm(rec.kind, item);
  }

  /* ----- catalogs ----- */
  function catalogPanel(c, cat) {
    const data = cat.data;
    const items = data ? arr(data.items).filter((x) => x && x.version) : [];
    const headExtra = [];
    if (data && data.fetchedAt) headExtra.push(h('span', {class: 'muted small', dataset: {since: data.fetchedAt, mode: 'ago', tpl: 'in.listAge'}}, t('in.listAge', {d: agoText(data.fetchedAt)})));
    headExtra.push(btn(t('in.reloadList'), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'refresh', disabled: !!cat.loading, onClick: () => loadCatalog(c.kind, true)}));
    const head = h('div', {class: 'panel-head'},
      h('h2', {class: 'panel-title'}, icon(c.icon), c.title),
      items.length ? chip(String(items.length), {}) : null,
      h('span', {class: 'panel-sub'}, t('in.cat.' + c.kind, {host: c.host})),
      h('span', {class: 'spacer'}), headExtra);
    let body;
    if (!data && cat.loading) {
      body = h('div', {class: 'panel-body'}, h('div', {class: 'row muted small'}, spinner(), t('in.listLoading', {host: c.host})));
    } else if (!data && cat.error) {
      const offline = cat.error.code === 'NET_FAILED' || cat.error.code === 'NETWORK';
      body = h('div', {class: 'panel-body'}, callout(offline ? 'warn' : 'bad', offline ? t('in.offlineTitle') : t('in.catFail', {what: c.title}),
        h('div', {class: 'stack'}, h('div', null, errorText(cat.error)), offline ? h('div', {class: 'muted small'}, t('in.offlineHint')) : null),
        [btn(t('common.retry'), {size: 'sm', icon: 'refresh', onClick: () => loadCatalog(c.kind, true)})]));
    } else if (!items.length) {
      body = h('div', {class: 'panel-body'}, h('p', {class: 'muted'}, t('in.emptyList')));
    } else {
      const all = !!IN.showAll[c.kind];
      const shown = all ? items : items.slice(0, CATALOG_PREVIEW);
      body = h('div', {class: 'panel-body flush'},
        cat.error ? h('div', {class: 'in-stale'}, callout('warn', null, t('in.staleList', {err: errorText(cat.error)}))) : null,
        h('div', {class: 'table-wrap'}, h('table', {class: 'table in-table'},
          headRow([t('th.version'), t('in.th.file'), t('in.th.size'), t('in.th.check'), '']),
          h('tbody', null, shown.map((it) => catalogRow(c, it))))),
        items.length > CATALOG_PREVIEW ? h('div', {class: 'in-more'}, btn(all ? t('in.showLess') : tn('in.showAll', items.length), {
          kind: 'ghost', size: 'sm', icon: all ? 'chevron-down' : 'list', onClick: () => { IN.showAll[c.kind] = !all; renderSetupPage(); }
        })) : null);
    }
    return h('section', {class: 'panel in-cat', 'aria-label': c.title, 'aria-busy': cat.loading ? 'true' : null}, head, body);
  }
  function catalogRow(c, it) {
    const key = installKey(c.kind, it.version);
    const running = IN.jobs[key];
    const verChip = c.kind === 'php' ? chip('PHP ' + it.version, {fam: famClass(it.version)})
      : chip(c.title + ' ' + it.version, {cls: 'chip-ver ' + (c.kind === 'mariadb' ? 'chip-mariadb' : 'chip-composer')});
    let action;
    if (it.installed) action = chip(t('in.installed'), {kind: 'ok', icon: 'check'});
    else if (running) action = btn(t('in.installing'), {size: 'sm', icon: 'clock', onClick: () => reopenInstall(c.kind, it.version)});
    else action = btn(t('in.install'), {size: 'sm', icon: 'download', ariaLabel: t('in.installAria', {what: c.title + ' ' + it.version}), onClick: () => openInstallConfirm(c.kind, it)});
    // Show the label only when it says more than the chip (toolset, minimum PHP, …).
    const label = String(it.label || '');
    const rest = label.replace(c.title, '').replace(String(it.build || it.version), '').replace(String(it.version), '')
      .replace(/\bLTS\b/g, '').replace(/[()·,\s-]+/g, ' ').trim();
    return h('tr', {class: it.installed ? 'is-installed' : null},
      h('td', null, h('div', {class: 'row in-ver'}, verChip, it.lts ? chip('LTS', {kind: 'info'}) : null),
        rest ? h('div', {class: 'muted small in-label', dir: 'ltr'}, label) : null),
      h('td', null, h('div', {class: 'cell-path'}, it.file || '-')),
      h('td', {class: 'num'}, it.sizeMB != null ? h('span', {class: 'ltr'}, fmtMB(it.sizeMB)) : '-'),
      h('td', null, it.sha256
        ? chip('SHA-256', {kind: 'ok', icon: 'shield', title: String(it.sha256)})
        : chip(t('in.shaFile'), {kind: 'info', icon: 'shield', title: t('in.shaFileTitle')})),
      h('td', {class: 'shrink'}, action));
  }

  /* ----- install: confirm -> job ----- */
  function installFolder(kind, it) {
    if (it.installDir || it.target) return String(it.installDir || it.target);
    const rdir = IN.sys && IN.sys.data && typeof IN.sys.data.runtimesDir === 'string' ? IN.sys.data.runtimesDir.replace(/[\\/]+$/, '') : '';
    if (rdir) return rdir + '\\' + kind + '\\' + it.version;
    const toolDir = S.state && S.state.panel && S.state.panel.toolDir ? String(S.state.panel.toolDir).replace(/[\\/]+$/, '') : '';
    const rel = 'runtimes\\' + kind + '\\' + it.version;
    return toolDir ? toolDir + '\\' + rel : rel;
  }
  function openInstallConfirm(kind, it) {
    const what = kindTitle(kind) + ' ' + it.version;
    const folder = installFolder(kind, it);
    const facts = [t('in.fact.sha'), t('in.fact.noAdmin'), hasT('in.fact.' + kind) ? t('in.fact.' + kind) : null, t('in.fact.never')].filter(Boolean);
    const m = openModal({
      title: t('in.confirmTitle', {what}), subtitle: t('in.confirmSub'), icon: 'download', size: 'md', alert: true,
      body: [
        kvList([
          [t('in.source'), it.url || '-', true],
          [t('in.th.file'), it.file || '-', true],
          [t('in.th.size'), it.sizeMB != null ? iso(fmtMB(it.sizeMB)) : t('in.sizeUnknown')],
          [t('in.verify'), it.sha256 ? h('span', {class: 'in-sha', title: String(it.sha256)}, h('span', null, t('in.verifySha') + ' '), h('code', {class: 'break'}, String(it.sha256))) : t('in.verifyFile')],
          [t('in.folder'), h('span', null, h('code', {class: 'break'}, folder), h('span', {class: 'muted small in-folder-note'}, ' ' + t('in.folderNote')))]
        ]),
        h('ul', {class: 'in-facts'}, facts.map((f) => h('li', null, icon('check'), h('span', null, f))))
      ],
      actions: [
        {label: t('common.cancel'), value: false},
        {id: 'go', label: t('in.confirmYes'), kind: 'primary', icon: 'download', autofocus: true, onClick: (ctrl, b) => startInstall(kind, it, ctrl, b)}
      ]
    });
    return m.result;
  }
  async function startInstall(kind, it, m, b) {
    const r = await modalBusy(m, b, t('common.startingShort'), () => api('POST', '/api/installer/install', {kind, version: it.version, confirm: true}));
    if (!r.ok || !r.jobId) {
      m.close(false);
      return failToast(t('in.installFail', {what: kindTitle(kind) + ' ' + it.version}), r);
    }
    m.close(true);
    const key = installKey(kind, it.version);
    IN.jobs[key] = r.jobId;
    renderSetupPage();
    watchInstall(kind, it.version, r.jobId);
  }
  function installJobOpts(kind, version) {
    const what = kindTitle(kind) + ' ' + version;
    return {
      title: t('in.jobTitle', {what}), icon: 'download',
      progress: (job) => jobProgress(job, true),
      renderResult: (job) => installResult(job, kind, what)
    };
  }
  function watchInstall(kind, version, jobId) {
    const o = installJobOpts(kind, version);
    o.onFinal = async () => {
      delete IN.jobs[installKey(kind, version)];
      renderSetupPage();
      await refreshNow();
      loadSystem();
      loadCatalog(kind, true);
    };
    showJob(jobId, o);
  }
  function reopenInstall(kind, version) {
    const id = IN.jobs[installKey(kind, version)];
    if (id) showJob(id, installJobOpts(kind, version));
  }
  function installResult(job, kind, what) {
    if (job.status !== 'done') return null;
    const res = job.result && typeof job.result === 'object' ? job.result : {};
    const where = res.dir || res.path || res.installDir || null;
    const next = kind === 'mariadb'
      ? [btn(t('in.openDb'), {size: 'sm', icon: 'db', onClick: () => goPage('db')})]
      : kind === 'php' ? [btn(t('in.openProjects'), {size: 'sm', icon: 'grid', onClick: () => goPage('projects')})] : [];
    return h('div', {class: 'stack'},
      callout('ok', t('in.doneTitle', {what}), h('div', {class: 'stack'},
        where ? h('div', null, t('in.doneWhere') + ' ', h('code', {class: 'break'}, String(where))) : null,
        h('div', null, t('in.done.' + kind)),
        kind === 'mariadb' && res.port ? h('div', null, t('in.doneDbPort', {port: res.port})) : null), next),
      ...genericResult(job));
  }

  /* ===================== phpMyAdmin (DB admin) ===================== */
  /**
   * Opens PHP Station's phpMyAdmin for a DB server ({dbServerId}), a project's database ({projectId})
   * or the server list ({}). The tab is opened right away (inside the click) and filled when the
   * backend answers, so the browser does not block it as a pop-up.
   */
  function openPma(body, b) {
    // opened by the panel in the default browser (openUrl), so no pop-up window is needed here
    return openPmaInto(body || {}, b, null);
  }
  async function openPmaInto(body, b, w) {
    if (b) setBusy(b, true, t('pma.opening'));
    const r = await api('POST', '/api/pma/open', body);
    if (b) setBusy(b, false);
    if (r.ok && safeUrl(r.url)) {
      const url = safeUrl(r.url);
      let shown = false;
      if (w && !w.closed) { try { w.opener = null; w.location.href = url; shown = true; } catch (e) { shown = false; } }
      if (!shown) openUrl(url);
      toast('success', t('pma.opened', {v: r.version || ''}), r.database ? t('pma.openedDb', {db: r.database}) : url, {
        duration: 9000, actions: [{label: t('pma.openAgain'), onClick: () => openUrl(url)}]
      });
      if (typeof r.note === 'string' && r.note) toast('info', t('proj.dbAuto'), bidi(r.note), {duration: 8000});
      refreshSoon();
      return;
    }
    if (w && !w.closed) { try { w.close(); } catch (e) { /* ignore */ } }
    if (r.code === 'PMA_MISSING') return pmaMissing(r, body);
    failToast(t('pma.openFail'), r);
  }
  async function stopPma(b) {
    setBusy(b, true);
    const r = await api('POST', '/api/pma/stop');
    setBusy(b, false);
    if (!r.ok) return failToast(t('pma.stopFail'), r);
    toast('success', r.wasRunning ? t('pma.stopped') : t('pma.notRunning'));
  }
  /** No phpMyAdmin in PHP Station yet: copy the XAMPP/Laragon one (offline) or download the official one. */
  function pmaMissing(r, body) {
    const local = arr(r.local).filter((x) => x && x.path && x.version);
    const after = (jobId, what) => showJob(jobId, {
      title: t('pma.installTitle', {what}), icon: 'download', progress: (job) => jobProgress(job, true),
      onFinal: (job) => { if (job.status === 'done') openPma(body, null); }
    });
    const m = openModal({
      title: t('pma.missingTitle'), subtitle: t('pma.missingSub'), icon: 'db', size: 'md',
      body: h('div', {class: 'stack'},
        h('p', {class: 'modal-text'}, t('pma.missingText')),
        local.length ? h('div', {class: 'check-list'}, local.map((x) => h('div', {class: 'check-item pma-choice'},
          h('span', {class: 'check-icon'}, icon('copy')),
          h('span', {class: 'check-main grow'},
            h('span', {class: 'check-title'}, t('pma.copyFrom', {stack: x.stack, v: x.version})),
            h('span', {class: 'check-desc mono'}, x.path)),
          btn(t('pma.copyBtn'), {size: 'sm', icon: 'copy', onClick: async (ev) => {
            const bb = ev.currentTarget;
            setBusy(bb, true);
            const res = await api('POST', '/api/pma/copy-local', {path: x.path, confirm: true});
            setBusy(bb, false);
            if (!res.ok || !res.jobId) return failToast(t('pma.copyFail'), res);
            m.close(true);
            after(res.jobId, x.stack + ' phpMyAdmin ' + x.version);
          }})))) : null,
        h('div', {class: 'check-list'}, h('div', {class: 'check-item pma-choice'},
          h('span', {class: 'check-icon'}, icon('download')),
          h('span', {class: 'check-main grow'},
            h('span', {class: 'check-title'}, t('pma.download')),
            h('span', {class: 'check-desc'}, t('pma.downloadDesc'))),
          btn(t('in.install'), {size: 'sm', kind: 'primary', icon: 'download', onClick: async (ev) => {
            const bb = ev.currentTarget;
            setBusy(bb, true);
            const cat = await api('GET', '/api/installer/catalog?kind=phpmyadmin');
            const it = cat.ok ? arr(cat.items).find((x) => x && x.version && !x.installed) : null;
            if (!it) { setBusy(bb, false); return failToast(t('in.catFail', {what: 'phpMyAdmin'}), cat.ok ? {error: t('in.emptyList')} : cat); }
            const res = await api('POST', '/api/installer/install', {kind: 'phpmyadmin', version: it.version, confirm: true});
            setBusy(bb, false);
            if (!res.ok || !res.jobId) return failToast(t('in.installFail', {what: 'phpMyAdmin ' + it.version}), res);
            m.close(true);
            after(res.jobId, 'phpMyAdmin ' + it.version);
          }}))),
        h('ul', {class: 'in-facts'}, [t('pma.fact1'), t('pma.fact2'), t('pma.fact3')].map((f) => h('li', null, icon('check'), h('span', null, f))))),
      actions: [{label: t('common.cancel'), value: null}]
    });
    return m.result;
  }

  /* ===================== Setup Wizard ===================== */
  // One place to set up a machine: what XAMPP/Laragon/... already have, what the projects need,
  // and one batch install (official sources, SHA-256 checked) of everything chosen.
  const WZ = {plan: null, loading: null, sel: new Set(), step: 1, m: null, opts: {}};
  const WZ_KINDS = [
    {kind: 'php', icon: 'code', title: 'PHP', host: 'windows.php.net'},
    {kind: 'mariadb', icon: 'db', title: 'MariaDB', host: 'mariadb.org'},
    {kind: 'composer', icon: 'package', title: 'Composer', host: 'getcomposer.org'},
    {kind: 'phpmyadmin', icon: 'globe', title: 'phpMyAdmin', host: 'phpmyadmin.net'}
  ];
  function wizKey(kind, v) { return kind + '@' + v; }
  function wizItems(kind) {
    const k = WZ.plan && WZ.plan.kinds && WZ.plan.kinds[kind];
    return k ? arr(k.items).filter((x) => x && x.version) : [];
  }
  function wizAutoSelect() {
    WZ.sel.clear();
    for (const c of WZ_KINDS) for (const it of wizItems(c.kind)) if (it.recommended && !it.installed) WZ.sel.add(wizKey(c.kind, it.version));
  }
  function wizSelected() {
    const out = [];
    for (const c of WZ_KINDS) for (const it of wizItems(c.kind)) if (WZ.sel.has(wizKey(c.kind, it.version)) && !it.installed) out.push({kind: c.kind, it});
    return out;
  }
  function wizTotalMB(list) {
    let mb = 0;
    let unknown = 0;
    for (const x of list) { if (x.it.sizeMB != null) mb += Number(x.it.sizeMB) || 0; else unknown++; }
    return {mb, unknown};
  }
  function loadWizardPlan() {
    if (WZ.loading) return WZ.loading;
    WZ.loading = api('GET', '/api/wizard/plan').then((r) => {
      WZ.loading = null;
      if (r.ok) WZ.plan = r;
      return r;
    });
    return WZ.loading;
  }
  function markWizardDone() {
    if (S.state && S.state.settings && S.state.settings.wizardDone === true) return;
    api('POST', '/api/settings', {wizardDone: true}).then((r) => {
      if (r.ok && r.settings && S.state) S.state.settings = Object.assign({}, S.state.settings, r.settings);
    });
  }

  /** Banner on the Install / Setup page. */
  function wizardHero() {
    return h('section', {class: 'panel wiz-hero', 'aria-label': t('wiz.title')},
      h('div', {class: 'wiz-hero-body'},
        h('div', {class: 'wiz-hero-icon'}, icon('sparkle')),
        h('div', {class: 'wiz-hero-text'},
          h('h2', {class: 'wiz-hero-title'}, t('wiz.title')),
          h('p', {class: 'muted'}, t('wiz.heroText')),
          h('ul', {class: 'wiz-hero-points'},
            [t('wiz.point1'), t('wiz.point2'), t('wiz.point3'), t('wiz.point4')].map((x) => h('li', null, icon('check'), h('span', null, x))))),
        h('div', {class: 'wiz-hero-act'},
          btn(t('wiz.open'), {kind: 'primary', icon: 'sparkle', onClick: () => openWizard({})}),
          btn(t('wiz.autoAll'), {icon: 'wand', onClick: () => openWizard({auto: true})}))));
  }

  /** opts: {auto} jumps to the confirm step with the recommended picks; {firstRun} shows "Baad me". */
  async function openWizard(opts) {
    if (WZ.m && !WZ.m.closed) return;
    WZ.opts = opts || {};
    WZ.step = 1;
    const m = openModal({
      title: t('wiz.title'), subtitle: t('wiz.sub'), icon: 'sparkle', size: 'xl', className: 'wiz-modal',
      body: h('div', {class: 'row muted wiz-loading'}, spinner(), t('wiz.loading')),
      actions: [{label: t('common.close'), value: null}],
      onClose: () => { WZ.m = null; }
    });
    WZ.m = m;
    const r = await loadWizardPlan();
    if (m.closed) return;
    if (!r.ok) {
      m.body.replaceChildren(callout('bad', t('wiz.planFail'), errorText(r),
        [btn(t('common.retry'), {size: 'sm', icon: 'refresh', onClick: () => { m.close(); openWizard(WZ.opts); }})]));
      return;
    }
    wizAutoSelect();
    if (WZ.opts.auto) WZ.step = wizSelected().length ? 3 : 2;
    renderWizard();
  }

  function wizStepper() {
    const steps = [t('wiz.step1'), t('wiz.step2'), t('wiz.step3')];
    return h('ol', {class: 'wiz-steps', 'aria-label': t('wiz.stepsAria')}, steps.map((s, i) => h('li', {
      class: ['wiz-step', WZ.step === i + 1 && 'is-current', WZ.step > i + 1 && 'is-done'],
      'aria-current': WZ.step === i + 1 ? 'step' : null
    }, h('span', {class: 'wiz-step-n'}, WZ.step > i + 1 ? icon('check') : String(i + 1)), h('span', null, s))));
  }

  function renderWizard() {
    const m = WZ.m;
    if (!m || m.closed || !WZ.plan) return;
    const body = WZ.step === 1 ? wizStepHave() : WZ.step === 2 ? wizStepChoose() : wizStepConfirm();
    m.body.replaceChildren(wizStepper(), body);
    const sel = wizSelected();
    const later = WZ.opts.firstRun ? {label: t('wiz.later'), left: true, onClick: (c) => { markWizardDone(); c.close(null); }} : null;
    if (WZ.step === 1) {
      m.setActions([later || {label: t('common.close'), left: true, value: null},
        {label: t('wiz.next'), kind: 'primary', icon: 'arrow', autofocus: true, onClick: () => { WZ.step = 2; renderWizard(); }}]);
    } else if (WZ.step === 2) {
      m.setActions([{label: t('wiz.back'), left: true, onClick: () => { WZ.step = 1; renderWizard(); }},
        sel.length
          ? {label: tn('wiz.nextN', sel.length), kind: 'primary', icon: 'arrow', onClick: () => { WZ.step = 3; renderWizard(); }}
          : {label: t('wiz.nothingNeeded'), kind: 'primary', icon: 'check', onClick: (c) => { markWizardDone(); c.close(null); toast('success', t('wiz.allSet')); }}]);
    } else {
      m.setActions([{label: t('wiz.back'), left: true, onClick: () => { WZ.step = 2; renderWizard(); }},
        {id: 'go', label: tn('wiz.installN', sel.length), kind: 'primary', icon: 'download', disabled: !sel.length, autofocus: true,
          onClick: (c, b) => wizStart(c, b)}]);
    }
    m.body.scrollTop = 0;
  }

  /* step 1: what this computer already has, and what the projects need */
  function wizStepHave() {
    const p = WZ.plan;
    const stacks = arr(p.stacks);
    const stackCards = stacks.length
      ? h('div', {class: 'wiz-stacks'}, stacks.map((s) => h('div', {class: 'wiz-stack'},
        h('div', {class: 'wiz-stack-head'}, chip(s.stack, {kind: s.stack === 'PHP Station' ? 'accent' : 'info'}), h('span', {class: 'mono small wiz-root', title: s.root}, s.root)),
        h('div', {class: 'wiz-stack-vers', dir: 'ltr'},
          arr(s.php).map((v) => chip('PHP ' + v, {fam: famClass(v)})),
          arr(s.db).map((v) => chip(v, {cls: 'chip-ver ' + (/^MySQL/.test(v) ? 'chip-mysql' : 'chip-mariadb')})),
          arr(s.composer).map((v) => chip('Composer ' + v, {cls: 'chip-ver chip-composer'}))))))
      : callout('info', t('wiz.noStacks'), t('wiz.noStacksText'));
    const projs = arr(p.projects);
    const shown = projs.slice(0, 60);
    const projTable = projs.length
      ? h('div', {class: 'table-wrap'}, h('table', {class: 'table wiz-table'},
        headRow([t('common.project'), 'Laravel', t('wiz.th.needs'), t('wiz.th.php')]),
        h('tbody', null, shown.map((x) => h('tr', null,
          h('td', null, h('div', {class: 'row'}, h('b', null, x.name), x.registered ? chip(t('wiz.inList'), {kind: 'ok'}) : null),
            h('div', {class: 'muted small mono cell-path', title: x.path}, x.path)),
          h('td', {class: 'mono'}, x.laravel || '-'),
          h('td', {class: 'mono'}, x.composerPhp || '-'),
          h('td', null, x.havePhp
            ? chip(t('wiz.haveIt', {v: x.havePhp}), {kind: 'ok', icon: 'check'})
            : x.branch ? chip(t('wiz.needBranch', {v: x.branch}), {kind: x.exact ? 'accent' : 'warn', icon: 'download'}) : h('span', {class: 'muted'}, '-')))))))
      : h('p', {class: 'muted'}, t('wiz.noProjects'));
    const sum = p.summary || {};
    return h('div', {class: 'stack'},
      h('div', {class: 'wiz-kpis'},
        wizKpi('code', 'PHP', sum.php), wizKpi('db', 'MariaDB / MySQL', sum.db), wizKpi('package', 'Composer', sum.composer), wizKpi('grid', t('wiz.projects'), projs.length)),
      h('h3', {class: 'wiz-h'}, icon('monitor'), t('wiz.haveTitle')), h('p', {class: 'muted small'}, t('wiz.haveSub')), stackCards,
      h('h3', {class: 'wiz-h'}, icon('grid'), t('wiz.projTitle')), h('p', {class: 'muted small'}, t('wiz.projSub')), projTable,
      projs.length > shown.length ? h('p', {class: 'muted small'}, t('wiz.moreProjects', {n: projs.length - shown.length})) : null);
  }
  function wizKpi(iconName, label, n) {
    return h('div', {class: 'wiz-kpi'}, h('span', {class: 'wiz-kpi-icon'}, icon(iconName)),
      h('div', null, h('div', {class: 'wiz-kpi-n'}, String(n == null ? 0 : n)), h('div', {class: 'muted small'}, label)));
  }

  /* step 2: choose versions (auto-selected from the plan) */
  function wizStepChoose() {
    const sel = wizSelected();
    const tot = wizTotalMB(sel);
    const sections = WZ_KINDS.map((c) => {
      const k = WZ.plan.kinds[c.kind] || {};
      const items = wizItems(c.kind);
      let list;
      if (!items.length) {
        list = k.error ? callout('warn', t('in.offlineTitle'), errorText(k.error)) : h('p', {class: 'muted'}, t('in.emptyList'));
      } else {
        list = h('div', {class: 'check-list'}, items.map((it) => wizItemRow(c, it)));
      }
      return h('section', {class: 'wiz-kind'},
        h('h3', {class: 'wiz-h'}, icon(c.icon), c.title, h('span', {class: 'muted small'}, t('wiz.from', {host: c.host}))),
        list);
    });
    return h('div', {class: 'stack'},
      h('div', {class: 'wiz-toolbar'},
        btn(t('wiz.auto'), {icon: 'wand', onClick: () => { wizAutoSelect(); renderWizard(); }}),
        btn(t('wiz.clear'), {kind: 'ghost', icon: 'x', onClick: () => { WZ.sel.clear(); renderWizard(); }}),
        h('span', {class: 'spacer'}),
        h('span', {class: 'wiz-total', 'aria-live': 'polite'}, sel.length
          ? t('wiz.total', {n: sel.length, mb: fmtMB(Math.round(tot.mb))}) + (tot.unknown ? ' +' : '')
          : t('wiz.noneChosen'))),
      callout('info', null, t('wiz.autoExplain')),
      sections,
      callout('info', t('wiz.mysqlTitle'), t('wiz.mysqlText')));
  }
  function wizItemRow(c, it) {
    const key = wizKey(c.kind, it.version);
    const cb = h('input', {type: 'checkbox', id: uid('wz'), checked: WZ.sel.has(key) || !!it.installed, disabled: !!it.installed});
    cb.addEventListener('change', () => { if (cb.checked) WZ.sel.add(key); else WZ.sel.delete(key); renderWizard(); });
    const ver = c.kind === 'php' ? chip('PHP ' + it.version, {fam: famClass(it.version)})
      : chip(c.title + ' ' + it.version, {cls: 'chip-ver ' + (c.kind === 'mariadb' ? 'chip-mariadb' : 'chip-composer')});
    const reasons = arr(it.reasons);
    const desc = it.installed ? t('wiz.alreadyInstalled')
      : reasons.length ? t('wiz.because') + ' ' + reasons.join(' · ')
        : it.haveBranch ? t('wiz.haveBranch') : (it.label || '');
    return h('label', {class: ['check-item', 'wiz-item', it.installed && 'is-blocked', it.recommended && 'is-rec'], for: cb.id},
      cb, h('span', {class: 'check-icon'}, icon(c.icon)),
      h('span', {class: 'check-main grow'},
        h('span', {class: 'check-title row'}, ver,
          it.lts ? chip('LTS', {kind: 'info'}) : null,
          it.eol ? chip('EOL', {kind: 'warn', title: t('wiz.eolTitle')}) : null,
          it.recommended ? chip(t('wiz.rec'), {kind: 'accent', icon: 'sparkle'}) : null,
          it.installed ? chip(t('in.installed'), {kind: 'ok', icon: 'check'}) : null),
        desc ? h('span', {class: 'check-desc'}, bidi(String(desc))) : null),
      h('span', {class: 'wiz-size muted small'}, it.sizeMB != null ? fmtMB(it.sizeMB) : ''));
  }

  /* step 3: what will happen */
  function wizStepConfirm() {
    const sel = wizSelected();
    const tot = wizTotalMB(sel);
    const rdir = WZ.plan.runtimesDir ? String(WZ.plan.runtimesDir).replace(/[\\/]+$/, '') : 'runtimes';
    const facts = [t('in.fact.sha'), t('in.fact.noAdmin'), t('wiz.factOrder'), t('wiz.factDb'), t('in.fact.never')];
    return h('div', {class: 'stack'},
      h('div', {class: 'table-wrap'}, h('table', {class: 'table wiz-table'},
        headRow([t('th.version'), t('in.source'), t('in.th.size'), t('in.folder')]),
        h('tbody', null, sel.map((x) => h('tr', null,
          h('td', null, chip(kindTitle(x.kind) + ' ' + x.it.version, x.kind === 'php' ? {fam: famClass(x.it.version)} : {cls: 'chip-ver ' + (x.kind === 'mariadb' ? 'chip-mariadb' : 'chip-composer')})),
          h('td', null, h('div', {class: 'cell-path mono small', title: x.it.url || ''}, x.it.url || '-')),
          h('td', {class: 'num'}, x.it.sizeMB != null ? fmtMB(x.it.sizeMB) : '-'),
          h('td', null, h('code', {class: 'break small'}, rdir + '\\' + x.kind + '\\' + x.it.version))))))),
      h('div', {class: 'wiz-total-row'}, icon('download'), t('wiz.total', {n: sel.length, mb: fmtMB(Math.round(tot.mb))}) + (tot.unknown ? ' +' : '')),
      h('ul', {class: 'in-facts'}, facts.map((f) => h('li', null, icon('check'), h('span', null, f)))));
  }

  async function wizStart(m, b) {
    const sel = wizSelected();
    if (!sel.length) return;
    const items = sel.map((x) => ({kind: x.kind, version: x.it.version}));
    const r = await modalBusy(m, b, t('common.startingShort'), () => api('POST', '/api/installer/install-batch', {items, confirm: true}));
    if (!r.ok || !r.jobId) return failToast(t('wiz.startFail'), r);
    markWizardDone();
    m.close(true);
    for (const x of items) IN.jobs[installKey(x.kind, x.version)] = r.jobId;
    if (S.mountedPage === 'setup') renderSetupPage();
    showJob(r.jobId, {
      title: t('wiz.jobTitle'), icon: 'download',
      progress: (job) => {
        const pg = jobProgress(job, true) || {pct: null, label: null, text: ''};
        const bt = job.batch && job.batch.total ? job.batch : null;
        if (bt) pg.label = '[' + bt.index + '/' + bt.total + '] ' + kindTitle(bt.kind) + ' ' + bt.version + (pg.label ? ' · ' + pg.label : '');
        return pg.label || pg.text || pg.pct != null ? pg : null;
      },
      renderResult: (job) => wizResult(job),
      onFinal: async () => {
        for (const x of items) delete IN.jobs[installKey(x.kind, x.version)];
        WZ.plan = null;
        await refreshNow();
        if (S.mountedPage === 'setup') { loadSystem(); for (const c of CATALOG_KINDS) loadCatalog(c.kind, true); }
      }
    });
  }
  function wizResult(job) {
    const res = job.result && typeof job.result === 'object' ? job.result : {};
    const done = arr(res.done);
    const failed = arr(res.failed);
    if (!done.length && !failed.length) return null;
    return h('div', {class: 'stack'},
      done.length ? callout('ok', t('wiz.doneTitle', {n: done.length}), h('div', {class: 'stack'},
        h('div', {class: 'row'}, done.map((x) => chip(kindTitle(x.kind) + ' ' + x.version, {kind: 'ok', icon: 'check'}))),
        done.some((x) => x.kind === 'mariadb') ? h('div', null, t('wiz.doneDb')) : null,
        done.some((x) => x.kind === 'php') ? h('div', null, t('wiz.donePhp')) : null),
      [btn(t('in.openProjects'), {size: 'sm', icon: 'grid', onClick: () => goPage('projects')}),
        btn(t('in.openDb'), {size: 'sm', icon: 'db', onClick: () => goPage('db')})]) : null,
      failed.length ? callout('bad', t('wiz.failedTitle', {n: failed.length}), h('ul', null,
        failed.map((x) => h('li', null, h('b', null, kindTitle(x.kind) + ' ' + x.version + ': '), bidi(String(x.error || x.code || '?')))))) : null);
  }

  /* ===================== Settings page ===================== */
  const SE = {};
  pageImpl.settings = {mount: mountSettings, update: updateSettings, snapshot: snapshotSettings, restore: restoreSettings,
    unmount() { for (const k of Object.keys(SE)) delete SE[k]; }};

  function listEditor(o) {
    let items = [];
    const box = h('div', {class: 'list-editor'});
    const input = h('input', {class: 'input mono', type: 'text', placeholder: o.placeholder || 'D:\\folder', 'aria-label': t('st.newPathAria', {label: o.label}), autocomplete: 'off', spellcheck: 'false'});
    const err = h('div', {class: 'field-error', 'aria-live': 'polite'});
    const render = () => {
      box.replaceChildren(...(items.length
        ? items.map((p, i) => h('div', {class: 'list-item'}, h('span', {class: 'mono', title: p}, p),
          btn(t('st.removeItem', {path: p}), {kind: 'ghost', size: 'sm', iconOnly: true, icon: 'x', onClick: () => { items.splice(i, 1); render(); o.onChange(); }})))
        : [h('div', {class: 'list-empty'}, o.emptyText || t('st.emptyList'))]));
    };
    const add = (value) => {
      const val = String(value != null ? value : input.value).trim();
      const problem = o.validate ? o.validate(val) : validateWinPath(val);
      if (problem) { err.textContent = problem; input.classList.add('is-invalid'); return; }
      if (items.some((x) => normPath(x) === normPath(val))) { err.textContent = t('st.dupe'); return; }
      items.push(val);
      input.value = '';
      err.textContent = '';
      input.classList.remove('is-invalid');
      render();
      o.onChange();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
    input.addEventListener('input', () => { err.textContent = ''; input.classList.remove('is-invalid'); });
    const browse = o.browse ? btn(t('common.browse'), {icon: 'folder', onClick: async (ev) => {
      const b = ev.currentTarget;
      setBusy(b, true);
      const r = await api('POST', '/api/pick-folder', {});
      setBusy(b, false);
      if (!r.ok) return failToast(t('np.pickFail'), r);
      if (r.path) add(r.path);
    }}) : null;
    render();
    return {
      el: h('div', {class: 'stack'}, box, h('div', {class: 'input-row'}, input, browse, btn(t('st.add'), {icon: 'plus', onClick: () => add()})), err),
      get: () => items.slice(),
      set: (list) => { items = arr(list).map(String); render(); err.textContent = ''; }
    };
  }
  function numInput(id, label) {
    return h('input', {class: 'input mono', id, type: 'number', min: 1024, max: 65535, 'aria-label': label});
  }
  function settingsSig(s) {
    return JSON.stringify([s.panelPort, s.webPortRange, s.dbPortRange, s.projectRoots, s.runtimeRoots, s.extraPaths, s.dumpDir, s.dbBindLocal, s.autoStartDb, s.dbEnvOverride,
      s.shutdownGuard, s.snapshotOnStart, s.snapshotKeep, s.snapshotMaxMB, s.dailyDump, s.dumpKeep, s.pointBeforeArtisan, s.pointKeep, s.phpWorkers, s.dbHistory, s.historyDays]);
  }
  function switchOf(el) {
    return el && (el.matches && el.matches('.switch') ? el : el.querySelector('.switch'));
  }
  function bindSwitch() { return switchOf(SE.bindLocal); }
  function swVal(el, dflt) {
    const sw = switchOf(el);
    return sw ? sw.getAttribute('aria-checked') === 'true' : dflt;
  }
  function swSet(el, v) {
    const sw = switchOf(el);
    if (sw) sw.setAttribute('aria-checked', String(!!v));
  }

  function mountSettings(root) {
    SE.dirty = false;
    const markDirty = () => { SE.dirty = true; updateSaveBar(); };
    SE.panelPort = numInput('st-panel-port', t('st.panelPort'));
    SE.webFrom = numInput('st-web-from', t('st.webFrom'));
    SE.webTo = numInput('st-web-to', t('st.webTo'));
    SE.dbFrom = numInput('st-db-from', t('st.dbFrom'));
    SE.dbTo = numInput('st-db-to', t('st.dbTo'));
    SE.dumpDir = h('input', {class: 'input mono', id: 'st-dump', type: 'text', autocomplete: 'off', spellcheck: 'false'});
    for (const el of [SE.panelPort, SE.webFrom, SE.webTo, SE.dbFrom, SE.dbTo, SE.dumpDir]) el.addEventListener('input', markDirty);
    SE.projectRoots = listEditor({label: t('st.projectRoots'), browse: true, onChange: markDirty, emptyText: t('st.projectRootsEmpty')});
    SE.runtimeRoots = listEditor({label: t('st.runtimeRoots'), browse: true, onChange: markDirty, emptyText: t('st.noFolder')});
    SE.extraPaths = listEditor({
      label: t('st.extraPaths'), browse: false, onChange: markDirty, placeholder: 'C:\\php-8.4\\php.exe', emptyText: t('st.extraEmpty'),
      validate: (x) => validateWinPath(x) || (/(php\.exe|\.phar|mysqld\.exe|mariadbd\.exe)$/i.test(x) ? null : t('rt.addInvalid'))
    });
    SE.bindLocal = makeSwitch({
      checked: true, label: t('st.bindLocal'), fk: 'bind',
      onToggle: (v, el) => { el.setAttribute('aria-checked', String(v)); markDirty(); }
    });
    SE.autoDb = makeSwitch({
      checked: true, label: t('st.autoDb'), fk: 'autodb',
      onToggle: (v, el) => { el.setAttribute('aria-checked', String(v)); markDirty(); }
    });
    SE.envOverride = makeSwitch({
      checked: true, label: t('st.envOverride'), fk: 'envov',
      onToggle: (v, el) => { el.setAttribute('aria-checked', String(v)); markDirty(); }
    });
    SE.guard = makeSwitch({checked: true, label: t('st.guard'), fk: 'guard', onToggle: (v, el) => { el.setAttribute('aria-checked', String(v)); markDirty(); }});
    SE.dailyDump = makeSwitch({checked: true, label: t('st.dailyDump'), fk: 'ddump', onToggle: (v, el) => { el.setAttribute('aria-checked', String(v)); markDirty(); }});
    SE.pointArtisan = makeSwitch({checked: true, label: t('st.pointArtisan'), fk: 'tmart', onToggle: (v, el) => { el.setAttribute('aria-checked', String(v)); markDirty(); }});
    SE.pointKeep = h('input', {class: 'input mono', id: 'st-point-keep', type: 'number', min: 1, max: 200});
    SE.phpWorkers = h('input', {class: 'input mono', id: 'st-php-workers', type: 'number', min: 1, max: 16});
    SE.dbHistory = makeSwitch({checked: true, label: t('st.dbHistory'), fk: 'dbhist', onToggle: (v, el) => { el.setAttribute('aria-checked', String(v)); markDirty(); }});
    SE.historyDays = h('input', {class: 'input mono', id: 'st-history-days', type: 'number', min: 1, max: 90});
    SE.snapOn = h('select', {class: 'select', id: 'st-snap-on'},
      ['daily', 'always', 'off'].map((x) => h('option', {value: x}, t('bk.on.' + x))));
    SE.snapKeep = h('input', {class: 'input mono', id: 'st-snap-keep', type: 'number', min: 1, max: 100});
    SE.dumpKeep = h('input', {class: 'input mono', id: 'st-dump-keep', type: 'number', min: 1, max: 100});
    SE.snapMax = h('input', {class: 'input mono', id: 'st-snap-max', type: 'number', min: 100, max: 1048576});
    for (const el of [SE.snapOn, SE.snapKeep, SE.dumpKeep, SE.snapMax, SE.pointKeep, SE.phpWorkers, SE.historyDays]) { el.addEventListener('input', markDirty); el.addEventListener('change', markDirty); }
    SE.guardStatus = h('div', {class: 'field-hint'}, t('common.loading'));
    api('GET', '/api/guard').then((g) => {
      if (!SE.guardStatus) return;
      SE.guardStatus.textContent = !g.ok ? errorText(g)
        : g.running ? t('st.guardRunning', {pid: g.pid, n: g.watching}) : g.enabled ? t('st.guardNotRunning') : t('st.guardOff');
    });
    const themeSeg = h('div', {class: 'seg', role: 'group', 'aria-label': t('top.theme')});
    for (const th of [{id: 'black', icon: 'moon'}, {id: 'silver', icon: 'sun'}, {id: 'auto', icon: 'monitor'}]) {
      const b = h('button', {type: 'button', class: 'seg-btn', dataset: {themeChoice: th.id}, 'aria-pressed': String(themePref === th.id)}, icon(th.icon), t('theme.' + th.id));
      b.addEventListener('click', () => setThemePref(th.id));
      themeSeg.appendChild(b);
    }
    // Language: each option is shown in its own script, so it can always be found again.
    const langSeg = h('div', {class: 'seg', role: 'group', 'aria-label': t('st.langLabel')});
    for (const l of LANGS) {
      const b = h('button', {
        type: 'button', class: 'seg-btn', dataset: {langChoice: l}, 'aria-pressed': String(lang === l),
        lang: l === 'ur' ? 'ur' : 'en', dir: l === 'ur' ? 'rtl' : 'ltr'
      }, LANG_NATIVE[l]);
      b.addEventListener('click', () => setLangPref(l));
      langSeg.appendChild(b);
    }
    SE.err = h('div', {class: 'field-error', 'aria-live': 'polite'});
    SE.saveState = h('span', {class: 'muted small'});
    SE.saveBtn = btn(t('st.save'), {kind: 'primary', icon: 'check', onClick: () => saveSettings()});
    SE.resetBtn = btn(t('st.reset'), {kind: 'ghost', icon: 'refresh', onClick: () => { SE.dirty = false; fillSettings(S.state.settings); }});
    SE.bar = h('div', {class: 'save-bar'}, icon('info'), h('div', {class: 'grow'}, SE.saveState, SE.err), SE.resetBtn, SE.saveBtn);
    const range = (a, b) => h('div', {class: 'range-row'}, a, h('span', {class: 'sep'}, '–'), b);
    const panel = (iconName, title, sub, ...content) => h('section', {class: 'panel', 'aria-label': title},
      h('div', {class: 'panel-head'}, h('h2', {class: 'panel-title'}, icon(iconName), title), sub ? h('span', {class: 'panel-sub'}, sub) : null),
      h('div', {class: 'panel-body stack'}, ...content));
    const portsPanel = panel('hash', t('st.ports'), null,
      field(t('st.panelPort'), SE.panelPort, null, t('st.panelPortHint')),
      field(t('st.phpWorkers'), SE.phpWorkers, null, t('st.phpWorkersHint')),
      h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('st.webPorts')), range(SE.webFrom, SE.webTo), h('div', {class: 'field-hint'}, t('st.webPortsHint'))),
      h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('st.dbPorts')), range(SE.dbFrom, SE.dbTo)));
    const dbAutoPanel = panel('db', t('st.dbAuto'), null,
      h('div', {class: 'field'}, h('div', {class: 'row'}, SE.autoDb, h('span', null, t('st.autoDbText'))), h('div', {class: 'field-hint'}, t('st.autoDbHint'))),
      h('div', {class: 'field'}, h('div', {class: 'row'}, SE.envOverride, h('span', null, t('st.envOverrideText'))), h('div', {class: 'field-hint'}, t('st.envOverrideHint'))));
    const safetyPanel = panel('shield', t('st.safety'), null,
      h('div', {class: 'field'}, h('div', {class: 'row'}, SE.guard, h('span', null, t('st.guardText'))), h('div', {class: 'field-hint'}, t('st.guardHint')), SE.guardStatus),
      field(t('st.snapOn'), SE.snapOn, null, t('st.snapOnHint')),
      h('div', {class: 'range-row'}, field(t('st.snapKeep'), SE.snapKeep), field(t('st.snapMax'), SE.snapMax)),
      h('div', {class: 'field'}, h('div', {class: 'row'}, SE.dailyDump, h('span', null, t('st.dailyDumpText'))), h('div', {class: 'field-hint'}, t('st.dailyDumpHint'))),
      field(t('st.dumpKeep'), SE.dumpKeep, null, t('st.backupWhere')),
      h('div', {class: 'field'}, h('div', {class: 'row'}, SE.pointArtisan, h('span', null, t('st.pointArtisanText'))), h('div', {class: 'field-hint'}, t('st.pointArtisanHint'))),
      field(t('st.pointKeep'), SE.pointKeep, null, t('st.pointKeepHint')),
      h('div', {class: 'field'}, h('div', {class: 'row'}, SE.dbHistory, h('span', null, t('st.dbHistoryText'))), h('div', {class: 'field-hint'}, t('st.dbHistoryHint'))),
      field(t('st.historyDays'), SE.historyDays, null, t('st.historyDaysHint')));
    const foldersPanel = panel('folder', t('st.folders'), null,
      h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('st.projectRootsLabel')), SE.projectRoots.el),
      h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('st.runtimeRootsLabel')), SE.runtimeRoots.el),
      h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('st.extraPaths')), SE.extraPaths.el),
      field(t('st.dumpLabel'), SE.dumpDir, null, t('st.dumpHint')));
    const lookPanel = panel('sun', t('st.look'), null,
      h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('st.langLabel')), langSeg, h('div', {class: 'field-hint'}, t('st.langHint'))),
      h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('st.themeLabel')), themeSeg),
      h('div', {class: 'field'}, h('span', {class: 'field-label'}, t('st.network')), h('div', {class: 'row'}, SE.bindLocal, h('span', null, t('st.bindLocalText')))));
    const shortcutBtn = btn(t('st.shortcut'), {icon: 'monitor', onClick: (ev) => createShortcut(ev.currentTarget)});
    const stopBtn = btn(t('st.stopPanel'), {kind: 'soft-danger', icon: 'power', onClick: () => shutdownPanel()});
    const panelPanel = h('section', {class: 'panel danger-zone', 'aria-label': t('st.panel')},
      h('div', {class: 'panel-head'}, h('h2', {class: 'panel-title'}, icon('power'), t('st.panel')),
        h('span', {class: 'panel-sub'}, S.state.panel.dataDir ? t('st.data', {dir: S.state.panel.dataDir}) : '')),
      h('div', {class: 'panel-body stack'},
        h('div', {class: 'row'}, shortcutBtn, h('span', {class: 'muted small'}, t('st.shortcutHint'))),
        h('div', {class: 'row'}, stopBtn, h('span', {class: 'muted small'}, t('st.stopHint')))));
    root.append(h('div', {class: 'settings-grid'},
      h('div', {class: 'settings-col'}, portsPanel, dbAutoPanel, safetyPanel, lookPanel, aboutPanel(), panelPanel),
      h('div', {class: 'settings-col'}, foldersPanel)), SE.bar);
    fillSettings(S.state.settings);
  }
  /** About: version, who built it (link opens in a new window / the default browser), license. Nothing more is claimed. */
  function aboutPanel() {
    const ver = (S.state && S.state.panel && S.state.panel.version) || APP_VERSION_FALLBACK;
    const site = h('a', {class: 'about-link', href: X8CODE_URL, target: '_blank', rel: 'noopener noreferrer', title: t('about.siteTitle')},
      icon('globe'), h('span', {class: 'ltr'}, 'x8code.com'), icon('external', 'about-ext'));
    return h('section', {class: 'panel about-panel', 'aria-label': t('about.title')},
      h('div', {class: 'panel-head'}, h('h2', {class: 'panel-title'}, icon('info'), t('about.title'))),
      h('div', {class: 'panel-body about'},
        h('div', {class: 'about-brand'}, brandMark('brand-mark about-mark'),
          h('div', {class: 'about-id'},
            h('div', {class: 'about-name', dir: 'ltr'}, h('span', {class: 'brand-name'}, 'PHP ', h('b', null, 'Station')), h('span', {class: 'about-ver mono'}, 'v' + ver)),
            h('div', {class: 'muted small', dir: 'ltr'}, 'PHP · Composer · MariaDB'))),
        h('div', {class: 'about-credit'}, h('span', {class: 'about-by'}, t('about.madeBy')), site),
        h('dl', {class: 'about-list'},
          h('dt', null, t('about.version')), h('dd', null, h('span', {class: 'ltr'}, 'PHP Station v' + ver)),
          h('dt', null, t('about.licenseLabel')), h('dd', null, h('span', {class: 'ltr'}, 'MIT License'), h('span', {class: 'muted small ltr'}, 'Copyright (c) 2026 Sami Hussain')))));
  }
  function fillSettings(s) {
    if (!SE.panelPort) return;
    const web = arr(s.webPortRange);
    const db = arr(s.dbPortRange);
    SE.panelPort.value = s.panelPort != null ? String(s.panelPort) : '';
    SE.webFrom.value = web[0] != null ? String(web[0]) : '';
    SE.webTo.value = web[1] != null ? String(web[1]) : '';
    SE.dbFrom.value = db[0] != null ? String(db[0]) : '';
    SE.dbTo.value = db[1] != null ? String(db[1]) : '';
    SE.dumpDir.value = s.dumpDir || '';
    SE.projectRoots.set(s.projectRoots);
    SE.runtimeRoots.set(s.runtimeRoots);
    SE.extraPaths.set(s.extraPaths);
    const sw = bindSwitch();
    if (sw) sw.setAttribute('aria-checked', String(s.dbBindLocal !== false));
    swSet(SE.autoDb, s.autoStartDb !== false);
    swSet(SE.envOverride, s.dbEnvOverride !== false);
    swSet(SE.guard, s.shutdownGuard !== false);
    swSet(SE.dailyDump, s.dailyDump !== false);
    SE.snapOn.value = ['daily', 'always', 'off'].includes(s.snapshotOnStart) ? s.snapshotOnStart : 'daily';
    SE.snapKeep.value = String(s.snapshotKeep || 7);
    SE.dumpKeep.value = String(s.dumpKeep || 7);
    SE.snapMax.value = String(s.snapshotMaxMB || 4096);
    swSet(SE.pointArtisan, s.pointBeforeArtisan !== false);
    SE.pointKeep.value = String(s.pointKeep || 20);
    SE.phpWorkers.value = String(s.phpWorkers || 4);
    swSet(SE.dbHistory, s.dbHistory !== false);
    SE.historyDays.value = String(s.historyDays || 7);
    SE.loadedSig = settingsSig(s);
    SE.dirty = false;
    SE.err.textContent = '';
    updateSaveBar();
    updateThemeButton();
    updateLangControls();
  }
  /** Unsaved form values, kept across a language switch (which rebuilds the page). */
  function snapshotSettings() {
    if (!SE.panelPort || !SE.dirty) return null;
    const sw = bindSwitch();
    return {
      panelPort: SE.panelPort.value, webFrom: SE.webFrom.value, webTo: SE.webTo.value, dbFrom: SE.dbFrom.value, dbTo: SE.dbTo.value,
      dumpDir: SE.dumpDir.value, projectRoots: SE.projectRoots.get(), runtimeRoots: SE.runtimeRoots.get(), extraPaths: SE.extraPaths.get(),
      bind: sw ? sw.getAttribute('aria-checked') : 'true',
      autoDb: swVal(SE.autoDb, true), envOverride: swVal(SE.envOverride, true),
      guard: swVal(SE.guard, true), dailyDump: swVal(SE.dailyDump, true),
      snapOn: SE.snapOn.value, snapKeep: SE.snapKeep.value, dumpKeep: SE.dumpKeep.value, snapMax: SE.snapMax.value,
      pointArtisan: swVal(SE.pointArtisan, true), pointKeep: SE.pointKeep.value, phpWorkers: SE.phpWorkers.value, dbHistory: swVal(SE.dbHistory, true), historyDays: SE.historyDays.value
    };
  }
  function restoreSettings(s) {
    if (!SE.panelPort || !s) return;
    SE.panelPort.value = s.panelPort; SE.webFrom.value = s.webFrom; SE.webTo.value = s.webTo;
    SE.dbFrom.value = s.dbFrom; SE.dbTo.value = s.dbTo; SE.dumpDir.value = s.dumpDir;
    SE.projectRoots.set(s.projectRoots); SE.runtimeRoots.set(s.runtimeRoots); SE.extraPaths.set(s.extraPaths);
    const sw = bindSwitch();
    if (sw) sw.setAttribute('aria-checked', s.bind);
    swSet(SE.autoDb, s.autoDb !== false);
    swSet(SE.envOverride, s.envOverride !== false);
    swSet(SE.guard, s.guard !== false);
    swSet(SE.dailyDump, s.dailyDump !== false);
    SE.snapOn.value = s.snapOn || 'daily'; SE.snapKeep.value = s.snapKeep; SE.dumpKeep.value = s.dumpKeep; SE.snapMax.value = s.snapMax;
    swSet(SE.pointArtisan, s.pointArtisan !== false); SE.pointKeep.value = s.pointKeep; SE.phpWorkers.value = s.phpWorkers; swSet(SE.dbHistory, s.dbHistory !== false); SE.historyDays.value = s.historyDays;
    SE.dirty = true;
    updateSaveBar();
  }
  function updateSaveBar() {
    if (!SE.bar) return;
    SE.bar.classList.toggle('is-dirty', !!SE.dirty);
    SE.saveState.textContent = SE.dirty ? t('st.unsaved') : t('st.allSaved');
    SE.saveBtn.disabled = !SE.dirty;
    SE.resetBtn.disabled = !SE.dirty;
  }
  function updateSettings(st) {
    if (!SE.panelPort) return;
    if (!SE.dirty && settingsSig(st.settings) !== SE.loadedSig && !isLocked(byId('main'))) fillSettings(st.settings);
    updateThemeButton();
    updateLangControls();
  }
  function readRange(a, b, name) {
    const from = validPort(a.value);
    const to = validPort(b.value);
    if (!from || !to) return {error: t('st.rangeInvalid', {name})};
    if (from > to) return {error: t('st.rangeOrder', {name})};
    return {value: [from, to]};
  }
  async function saveSettings() {
    SE.err.textContent = '';
    const panelPort = validPort(SE.panelPort.value);
    if (!panelPort) { SE.err.textContent = t('st.panelPortInvalid'); SE.panelPort.focus(); return; }
    const web = readRange(SE.webFrom, SE.webTo, t('st.webPortsShort'));
    if (web.error) { SE.err.textContent = web.error; SE.webFrom.focus(); return; }
    const db = readRange(SE.dbFrom, SE.dbTo, t('st.dbPortsShort'));
    if (db.error) { SE.err.textContent = db.error; SE.dbFrom.focus(); return; }
    const dump = SE.dumpDir.value.trim();
    const dumpProblem = validateWinPath(dump);
    if (dumpProblem) { SE.err.textContent = t('st.dumpInvalid', {err: dumpProblem}); SE.dumpDir.focus(); return; }
    const sw = bindSwitch();
    const before = S.state.settings;
    const body = {
      panelPort, webPortRange: web.value, dbPortRange: db.value,
      projectRoots: SE.projectRoots.get(), runtimeRoots: SE.runtimeRoots.get(), extraPaths: SE.extraPaths.get(),
      dumpDir: dump, dbBindLocal: sw ? sw.getAttribute('aria-checked') === 'true' : true,
      autoStartDb: swVal(SE.autoDb, true), dbEnvOverride: swVal(SE.envOverride, true),
      shutdownGuard: swVal(SE.guard, true), dailyDump: swVal(SE.dailyDump, true), snapshotOnStart: SE.snapOn.value,
      snapshotKeep: Number(SE.snapKeep.value), dumpKeep: Number(SE.dumpKeep.value), snapshotMaxMB: Number(SE.snapMax.value),
      pointBeforeArtisan: swVal(SE.pointArtisan, true), pointKeep: Number(SE.pointKeep.value), phpWorkers: Number(SE.phpWorkers.value), dbHistory: swVal(SE.dbHistory, true), historyDays: Number(SE.historyDays.value)
    };
    setBusy(SE.saveBtn, true, t('common.saving'));
    const r = await api('POST', '/api/settings', body);
    setBusy(SE.saveBtn, false);
    if (!r.ok) { SE.err.textContent = errorText(r); failToast(t('st.saveFail'), r); updateSaveBar(); return; }
    SE.dirty = false;
    if (r.settings && S.state) S.state.settings = Object.assign({}, S.state.settings, r.settings);
    fillSettings(S.state.settings);
    toast('success', t('st.saved'));
    if (Number(before.panelPort) !== panelPort) toast('info', t('st.panelPort'), t('st.panelPortToast', {port: panelPort}));
    const rootsChanged = JSON.stringify([before.runtimeRoots, before.extraPaths]) !== JSON.stringify([body.runtimeRoots, body.extraPaths]);
    if (rootsChanged) toast('info', t('st.rescanQ'), t('st.rescanMsg'), {actions: [{label: t('st.scanNow'), onClick: () => startScan(null)}], duration: 9000});
    refreshSoon();
  }
  async function createShortcut(b) {
    setBusy(b, true, t('common.creating'));
    const r = await api('POST', '/api/shortcut');
    setBusy(b, false);
    if (!r.ok) return failToast(t('st.shortcutFail'), r);
    toast('success', t('st.shortcutDone'), r.path || null);
  }
  async function shutdownPanel() {
    const yes = await confirmDialog({
      title: t('st.stopQ'), icon: 'power', tone: 'warn',
      message: t('st.stopMsg'),
      confirmLabel: t('st.stopYes')
    });
    if (!yes) return;
    const r = await api('POST', '/api/shutdown');
    if (!r.ok && r.code !== 'NETWORK') return failToast(t('st.stopFail'), r);
    stopPolling();
    closeDrawer(true);
    document.body.appendChild(h('div', {class: 'overlay-full', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'bye-title'},
      h('div', {class: 'overlay-card'}, brandMark(),
        h('h2', {id: 'bye-title'}, t('st.byeTitle')),
        h('p', {class: 'muted'}, t('st.byeText')))));
  }

  /* ===================== Init ===================== */
  function init() {
    mirrorErrors();
    buildChrome();
    let initial = pageFromHash() || lsGet('devpanel.page') || 'projects';
    if (!PAGES.some((p) => p.id === initial)) initial = 'projects';
    if (!pageFromHash()) {
      try { window.history.replaceState(null, '', '#/' + initial); } catch (e) { /* ignore */ }
    }
    showPage(initial);
    // An older panel process (started before i18n.js existed) cannot serve the dictionary: say how to fix it.
    if (!DICT.roman) {
      showBanner('i18n', 'bad', 'Texts (i18n.js) load nahi huay — PHP-Station-Stop.bat aur phir PHP-Station.bat chala kar panel restart karein. / UI texts failed to load — restart PHP Station.');
    }
    refresh().then(() => {
      schedulePoll();
      // First run: nothing set up yet -> the Setup Wizard opens by itself (once; "Baad me" also counts).
      const st = S.state;
      if (st && st.settings && st.settings.wizardDone !== true && !arr(st.projects).length) openWizard({firstRun: true});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

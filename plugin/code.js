// Deck Studio – Publish
// Exports every slide of this file and sends it to the Deck Studio site.
// Runs entirely inside Figma, so it doesn't use the Figma REST API (or its monthly limit).

var LOCKED = /^(lock|_)/i;
var SLOT = /^(logo-slot|logo:|logo change)/i;
var MIN_EDITABLE_PX = 14; // smaller text is UI detail inside screenshots
var MAX_BG_BYTES = 4000000; // the site accepts uploads up to ~4.5 MB each

figma.showUI(__html__, { width: 360, height: 470, themeColors: true });

function slidesInFile() {
  if (figma.editorType === 'slides') {
    return figma.getSlideGrid().flat().filter(function (s) { return !s.isSkippedSlide; });
  }
  var out = [];
  figma.currentPage.children.forEach(function (n) {
    if (n.type === 'SECTION') n.children.forEach(function (c) { out.push(c); });
    else out.push(n);
  });
  out = out.filter(function (n) {
    return n.visible && (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') && n.absoluteBoundingBox;
  });
  out.sort(function (a, b) {
    var A = a.absoluteBoundingBox, B = b.absoluteBoundingBox;
    var dy = Math.round(A.y / 100) - Math.round(B.y / 100);
    return dy !== 0 ? dy : A.x - B.x;
  });
  return out;
}

function deckName() {
  if (figma.editorType === 'slides') return figma.root.name;
  return figma.root.name + (figma.root.children.length > 1 ? ' – ' + figma.currentPage.name : '');
}

function rgba(c, alpha) {
  var to = function (v) { return Math.round(v * 255); };
  return 'rgba(' + to(c.r) + ', ' + to(c.g) + ', ' + to(c.b) + ', ' + Math.round(alpha * 1000) / 1000 + ')';
}

function first(t, prop, getter) {
  var v = t[prop];
  if (v !== figma.mixed) return v;
  return t[getter](0, 1);
}

function opacityChain(node, stop) {
  var o = 1;
  for (var n = node; n && n !== stop; n = n.parent) if (typeof n.opacity === 'number') o *= n.opacity;
  return o;
}

function isRotated(node) {
  var m = node.absoluteTransform;
  return Math.abs(m[0][1]) > 0.001 || Math.abs(m[1][0]) > 0.001 || m[0][0] < 0 || m[1][1] < 0;
}

function textStyle(t, slide) {
  var size = first(t, 'fontSize', 'getRangeFontSize');
  var font = first(t, 'fontName', 'getRangeFontName');
  var weight = first(t, 'fontWeight', 'getRangeFontWeight');
  var fills = first(t, 'fills', 'getRangeFills');
  var ls = first(t, 'letterSpacing', 'getRangeLetterSpacing');
  var lh = first(t, 'lineHeight', 'getRangeLineHeight');
  var tc = first(t, 'textCase', 'getRangeTextCase');
  var fill = (fills || []).filter(function (f) { return f.visible !== false; })[0];
  var solid = !fill || fill.type === 'SOLID';
  var alpha = (fill && fill.opacity != null ? fill.opacity : 1) * opacityChain(t, slide);
  var color = fill && fill.type === 'SOLID' ? rgba(fill.color, alpha) : 'rgba(0,0,0,1)';
  var lineHeightPx = 0; // 0 = "auto", measured from the font in the browser
  if (lh && lh.unit === 'PIXELS') lineHeightPx = lh.value;
  if (lh && lh.unit === 'PERCENT') lineHeightPx = (lh.value / 100) * size;
  var letterSpacing = 0;
  if (ls && ls.unit === 'PIXELS') letterSpacing = ls.value;
  if (ls && ls.unit === 'PERCENT') letterSpacing = (ls.value / 100) * size;
  var mixed = t.fontSize === figma.mixed || t.fontName === figma.mixed || t.fills === figma.mixed || t.fontWeight === figma.mixed;
  return {
    solid: solid,
    mixed: mixed,
    style: {
      fontFamily: font.family,
      fontWeight: weight || 400,
      fontSize: size,
      italic: /italic|oblique/i.test(font.style),
      align: t.textAlignHorizontal || 'LEFT',
      valign: t.textAlignVertical || 'TOP',
      letterSpacing: letterSpacing,
      lineHeightPx: lineHeightPx,
      textCase: tc && tc !== 'ORIGINAL' ? tc : 'ORIGINAL',
      color: color,
      autoResize: t.textAutoResize || 'NONE',
    },
  };
}

function tokensOf(text) {
  var seen = {}, out = [], re = /\{([A-Za-z][\w-]*)\}/g, m;
  while ((m = re.exec(text))) {
    var k = m[1].toLowerCase();
    if (!seen[k]) { seen[k] = 1; out.push(k); }
  }
  return out;
}

function slotKey(name) {
  var i = name.indexOf(':');
  return i === -1 ? 'client' : (name.slice(i + 1).trim().toLowerCase() || 'client');
}

function relBox(node, origin) {
  var b = node.absoluteBoundingBox;
  return { x: b.x - origin.x, y: b.y - origin.y, w: b.width, h: b.height };
}

/** Everything the layer paints (letters can reach outside the text box), relative to the slide. */
function paintBox(node, origin) {
  var b = node.absoluteRenderBounds;
  if (!b || !(b.width > 0) || !(b.height > 0)) return relBox(node, origin);
  return { x: b.x - origin.x, y: b.y - origin.y, w: b.width, h: b.height };
}

/** At least half of the layer is on the slide (skips text parked off-canvas or scrolled out of view). */
function onSlide(box, slide) {
  var w = slide.absoluteBoundingBox.width, h = slide.absoluteBoundingBox.height;
  var ix = Math.max(0, Math.min(box.x + box.w, w) - Math.max(box.x, 0));
  var iy = Math.max(0, Math.min(box.y + box.h, h) - Math.max(box.y, 0));
  return box.w > 0 && box.h > 0 && ix * iy >= 0.5 * box.w * box.h;
}

/** True when a frame around the layer crops part of it (e.g. text inside a product screenshot). */
function croppedByFrame(n, slide) {
  var b = n.absoluteBoundingBox;
  for (var p = n.parent; p && p !== slide; p = p.parent) {
    if (p.clipsContent && p.absoluteBoundingBox) {
      var c = p.absoluteBoundingBox;
      if (b.x < c.x - 1 || b.y < c.y - 1 || b.x + b.width > c.x + c.width + 1 || b.y + b.height > c.y + c.height + 1) return true;
    }
  }
  return false;
}

/** Text layers sales can edit and logo spots, in this slide. */
function collect(slide) {
  var origin = slide.absoluteBoundingBox;
  var texts = [], slots = [], nodes = {};
  function walk(n, locked) {
    if (!n.visible) return;
    var name = (n.name || '').trim();
    if (SLOT.test(name) && n.absoluteBoundingBox && onSlide(relBox(n, origin), slide) && !croppedByFrame(n, slide)) {
      slots.push({ id: n.id, name: name, key: slotKey(name), box: relBox(n, origin), pieceBox: paintBox(n, origin), alpha: opacityChain(n.parent, slide) });
      nodes[n.id] = n;
      return;
    }
    var isLocked = locked || LOCKED.test(name);
    if (n.type === 'TEXT') {
      var chars = n.characters || '';
      if (!chars.trim() || !n.absoluteBoundingBox || !onSlide(relBox(n, origin), slide) || croppedByFrame(n, slide)) return;
      var s = textStyle(n, slide);
      var editable = !isLocked && s.solid && s.style.fontSize >= MIN_EDITABLE_PX && !isRotated(n);
      if (!editable) return; // stays baked into the slide image
      texts.push({
        id: n.id,
        name: name || 'Text',
        characters: chars,
        box: relBox(n, origin),
        pieceBox: paintBox(n, origin),
        style: s.style,
        editable: true,
        mixed: s.mixed,
        tokens: tokensOf(chars),
        // a layer exported on its own loses the opacity of the groups around it
        alpha: opacityChain(n.parent, slide),
      });
      nodes[n.id] = n;
      return;
    }
    if ('children' in n) n.children.forEach(function (c) { walk(c, isLocked); });
  }
  if ('children' in slide) slide.children.forEach(function (c) { walk(c, false); });
  return { texts: texts, slots: slots, nodes: nodes };
}

function fileId(id) { return id.replace(/[^\w-]/g, '_'); }

var acks = {};
function sendAndWait(msg) {
  return new Promise(function (resolve, reject) {
    var key = 'k' + Math.random().toString(36).slice(2);
    acks[key] = { resolve: resolve, reject: reject };
    msg.ack = key;
    figma.ui.postMessage(msg);
  });
}

async function exportBackground(slide) {
  var scales = [2, 1.5, 1];
  var bytes = null;
  for (var i = 0; i < scales.length; i++) {
    bytes = await slide.exportAsync({ format: 'JPG', constraint: { type: 'SCALE', value: scales[i] } });
    if (bytes.length <= MAX_BG_BYTES) break;
  }
  return bytes;
}

async function publish() {
  var slides = slidesInFile();
  if (!slides.length) throw new Error(figma.editorType === 'slides' ? 'This presentation has no slides.' : 'No frames on this page. Put each slide in a frame.');
  figma.ui.postMessage({ type: 'start', total: slides.length, name: deckName() });

  for (var i = 0; i < slides.length; i++) {
    var slide = slides[i];
    var c = collect(slide);
    var ids = Object.keys(c.nodes);
    var files = [];

    // 1. Each editable layer on its own (transparent PNG), so unedited ones look exactly like Figma.
    //    Exported with everything it paints, not cropped to its box, so no letter gets cut off.
    for (var j = 0; j < ids.length; j++) {
      var node = c.nodes[ids[j]];
      var png = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
      files.push({ name: 'p-' + fileId(ids[j]) + '.png', mime: 'image/png', bytes: png, piece: ids[j] });
    }

    // 2. The slide with those layers made fully transparent. Transparent (not hidden) so auto-layout
    //    frames keep every gap exactly as the designer set it. Opacity is restored straight after.
    var faded = [];
    try {
      ids.forEach(function (id) {
        var n = c.nodes[id];
        faded.push({ node: n, opacity: n.opacity });
        n.opacity = 0;
      });
      var bg = await exportBackground(slide);
    } finally {
      faded.forEach(function (f) { f.node.opacity = f.opacity; });
    }
    files.push({ name: 'bg-' + fileId(slide.id) + '.jpg', mime: 'image/jpeg', bytes: bg, bg: true });

    // 3. A small picture of the whole slide for the deck library and slide list.
    var thumb = await slide.exportAsync({ format: 'JPG', constraint: { type: 'WIDTH', value: 480 } });
    files.push({ name: 'th-' + fileId(slide.id) + '.jpg', mime: 'image/jpeg', bytes: thumb, thumb: true });

    var b = slide.absoluteBoundingBox;
    var label = slide.name && !/^\d+$/.test(slide.name) ? slide.name : 'Slide ' + (i + 1);
    await sendAndWait({
      type: 'slide',
      index: i,
      total: slides.length,
      slide: { id: slide.id, name: label, width: Math.round(b.width), height: Math.round(b.height), texts: c.texts, slots: c.slots },
      files: files,
    });
  }
  figma.ui.postMessage({ type: 'exported' });
}

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'init') {
    var site = await figma.clientStorage.getAsync('site');
    var key = await figma.clientStorage.getAsync('passcode');
    figma.ui.postMessage({ type: 'init', name: deckName(), count: slidesInFile().length, site: site || '', passcode: key || '' });
  }
  if (msg.type === 'remember') {
    await figma.clientStorage.setAsync('site', msg.site);
    await figma.clientStorage.setAsync('passcode', msg.passcode);
  }
  if (msg.type === 'ack' && acks[msg.ack]) {
    var a = acks[msg.ack];
    delete acks[msg.ack];
    if (msg.error) a.reject(new Error(msg.error));
    else a.resolve();
  }
  if (msg.type === 'publish') {
    try {
      await publish();
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: (e && e.message) || String(e) });
    }
  }
  if (msg.type === 'done') {
    figma.notify('Deck published to Deck Studio');
  }
  if (msg.type === 'close') figma.closePlugin();
};

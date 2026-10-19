export type Box = { x: number; y: number; w: number; h: number };

export type TextStyle = {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  italic: boolean;
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  valign: 'TOP' | 'CENTER' | 'BOTTOM';
  letterSpacing: number; // px
  lineHeightPx: number;
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | string;
  color: string; // rgba()
  /** Figma auto-resize mode: WIDTH_AND_HEIGHT grows sideways, HEIGHT wraps and grows down, NONE is a fixed box. */
  autoResize: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT' | 'TRUNCATE';
};

export type TextLayer = {
  id: string; // Figma node id, matches data-node-id in the SVG
  name: string;
  characters: string;
  box: Box; // relative to the slide
  style: TextStyle;
  editable: boolean;
  /** Text has mixed styling in Figma; editing flattens it to the base style. */
  mixed: boolean;
  /** {tokens} found in the text, e.g. ["client"] */
  tokens: string[];
  /** Baseline of the first line in slide px, when known (Figma Slides files). */
  firstBaseline?: number;
  /** Opacity of the groups around the layer (published decks draw the layer image with it). */
  alpha?: number;
};

export type LogoSlot = {
  id: string;
  name: string;
  /** Slots with the same key share one logo across the deck. */
  key: string;
  box: Box;
  alpha?: number;
};

export type Slide = {
  id: string;
  name: string;
  width: number;
  height: number;
  /** URL of the slide SVG (decks synced through the Figma API). */
  svg?: string;
  /** Decks published from the Figma plugin: the slide image with editable layers removed… */
  bg?: string;
  /** …and each editable layer / logo spot as its own image, keyed by layer id. */
  pieces?: Record<string, string>;
  /** Small picture of the whole slide (deck library, slide list). */
  thumb?: string;
  texts: TextLayer[];
  slots: LogoSlot[];
  /**
   * Figma Slides files can't be read layer-by-layer through the API, so the sync stores a
   * second export with live text; the browser measures text layers and logo spots from it.
   */
  metaSvg?: string;
};

export type Deck = { id: string; name: string; slides: Slide[]; updatedAt?: string };

export type Manifest = {
  version: 1;
  source: 'figma' | 'demo' | 'published';
  syncedAt: string;
  fileName?: string;
  fileKey?: string;
  decks: Deck[];
};

export type LogoAsset = {
  pathname: string;
  url: string;
  name: string;
  uploadedAt: string;
  size: number;
};

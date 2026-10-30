# Changelog

What changed in each release of Deck Studio, newest first. Each Vercel deployment's message matches the top entry.

## 2026-10-30 — Restore removed decks
- For designers → "Show removed decks" lists every deck that was removed from the library, with Restore (or Restore all). Needs the designer passcode.

## 2026-10-30 — Deck library sorted by name, with search
- Decks whose names start with a number come first, in number order (5.1 before 15.1 before 16), then the rest A to Z.
- Search box at the top of the library: finds decks by any word or part of a word in the deck name or in the text on its slides. When the match is on a slide, the card shows which slide and the line it was found in. Esc clears the search.

## 2026-10-19 — Find logo works on more websites (PR #2)
- Find logo now also reads responsive and lazy-loaded images, inline SVG logos, app manifest icons and compressed pages, and accepts a direct link to a logo image.
- GIF, AVIF, TIFF and ICO logos are converted to PNG so they work in slides and the PDF.
- When a website blocks the lookup, it tries the site's own favicon files, then Google's cached site icon (only the domain name is sent to Google).
- Clearer error messages: blocked site, timed out, or no logo found.

## 2026-10-19 — Delete logos from the library
- Hover a logo in the library and click × to delete it for everyone (asks to confirm). A deleted logo is also removed from the deck you have open.

## 2026-10-19 — Letters no longer cut off
- The Figma plugin now exports each text layer with everything it paints, so descenders and overhanging letters aren't clipped in the editor or the PDF. Re-publish decks with the new plugin to apply it.

## 2026-10-19 — Find logo from a company website (PR #1)
- Paste a company website in the logo library and click Find logo to save its logo. Upload box kept alongside it.

## 2026-10-19 — Deck library and spacing fixes
- Deck library: sales pick a deck to edit; designers publish decks from the Figma plugin.
- Plugin keeps the designer's auto-layout spacing when publishing.
- Opening a deck from the library shows the slide straight away.

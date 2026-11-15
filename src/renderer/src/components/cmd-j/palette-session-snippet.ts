const MATCH_MARKERS = /\[\[|\]\]/g
const ELLIPSES = /^(?:…|\.{3})\s*|\s*(?:…|\.{3})$/g

const plain = (text: string): string =>
  text.replace(MATCH_MARKERS, '').replace(ELLIPSES, '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Whether the excerpt tells the reader more than the title does. A title is the first prompt, so a hit on it
 * would print the same words twice.
 */
export function paletteSessionSnippetAddsInfo(snippet: string, title: string): boolean {
  const excerpt = plain(snippet)
  const heading = plain(title)
  if (excerpt === '') {
    return false
  }
  return !(heading.includes(excerpt) || excerpt.includes(heading))
}

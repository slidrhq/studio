/**
 * Cleaning the markup of a deck before it is drawn in the app's own page (SEC-03, SEC-06): an
 * `html` element without scripts, and an `svg` element. Markup with scripts never comes here; it
 * runs in a sandboxed frame instead.
 *
 * The boundary: markup of a deck is drawn and never run, whoever wrote it (the agent, a deck
 * somebody else made, a paste, the code dialog). This removes what can run code or start a
 * document of its own, and keeps everything that only draws, so that "any HTML renders as it
 * is" (SPEC 5.9) holds for everything that is not a script. An `svg` element is held to more
 * (`picture.ts`).
 *
 * Two rules for whoever uses it:
 *
 * - The tree that was cleaned is the tree that is drawn. A cleaned tree that is written out as
 *   a string and parsed again is another tree: HTML does not come back the same for every
 *   nesting, and what was text or an attribute the first time can be an element the second.
 *   `SlideRenderer` therefore appends the cleaned nodes themselves and never their markup. An
 *   export has to write a string, and checks what its string parses into (`@slidr/html-export`,
 *   `written.ts`). `sanitizeMarkup`, which returns a string, parses its own answer again until
 *   nothing in it needs cleaning.
 * - It is judged in a real browser (`boundary.browser.test.tsx`). The DOM the unit tests run on
 *   parses markup its own way, and what it shows of this file proves nothing.
 */

/** Elements that run code, hold a document of their own, or change how the rest is read. */
const DROPPED_ELEMENTS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'fencedframe',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'portal',
  // Read as text by a browser that runs scripts and as markup by one that does not.
  'noscript',
  // Draws nothing; and a file that holds one with `shadowrootmode` gives its content to the
  // browser as live markup of the element around it.
  'template',
]);

const URL_ATTRIBUTES = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'data',
  'poster',
]);

/** SVG elements that change an attribute of another element while the picture is shown. */
const ANIMATIONS = new Set(['set', 'animate', 'animatetransform', 'animatemotion', 'animatecolor']);

function isScriptUrl(value: string): boolean {
  // Browsers ignore whitespace and control characters inside the scheme.
  const compact = Array.from(value)
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join('')
    .toLowerCase();
  return compact.startsWith('javascript:') || compact.startsWith('vbscript:');
}

/**
 * An animation that writes a link or an event handler: the address it gives is not in any
 * attribute this file reads, and it arrives after the cleaning.
 */
export function animatesLink(el: Element): boolean {
  if (!ANIMATIONS.has(el.localName.toLowerCase())) return false;
  const target = (el.getAttribute('attributeName') ?? '').trim().toLowerCase();
  return target.startsWith('on') || target === 'href' || target.endsWith(':href');
}

const LINK_REL = 'noopener noreferrer';

function cleanElement(el: Element): boolean {
  let changed = false;
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || (URL_ATTRIBUTES.has(name) && isScriptUrl(attr.value))) {
      el.removeAttribute(attr.name);
      changed = true;
    }
  }
  // A link inside a slide must never navigate the editor's own window away. SVG has links too,
  // and an older one names its address in `xlink:href`.
  const tag = el.localName.toLowerCase();
  if (
    (tag === 'a' || tag === 'area') &&
    (el.hasAttribute('href') || el.hasAttribute('xlink:href'))
  ) {
    if (el.getAttribute('target') !== '_blank' || el.getAttribute('rel') !== LINK_REL) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', LINK_REL);
      changed = true;
    }
  }
  return changed;
}

/** Comments and processing instructions: they draw nothing. */
function dropComments(root: ParentNode): boolean {
  const doc = root.ownerDocument ?? (root as Document);
  // 0x80 is a comment, 0x40 a processing instruction (`NodeFilter.SHOW_*`).
  const walker = doc.createTreeWalker(root, 0x80 | 0x40);
  const found: Node[] = [];
  while (walker.nextNode()) found.push(walker.currentNode);
  for (const node of found) node.parentNode?.removeChild(node);
  return found.length > 0;
}

function cleanTree(root: ParentNode): boolean {
  let changed = dropComments(root);
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (DROPPED_ELEMENTS.has(el.localName.toLowerCase()) || animatesLink(el)) {
      el.remove();
      changed = true;
    } else if (cleanElement(el)) changed = true;
  }
  return changed;
}

/** Parses markup as HTML (inline SVG included) into a detached fragment of `doc`. */
export function parseFragment(markup: string, doc: Document = document): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = markup;
  return template.content;
}

export function serializeFragment(fragment: DocumentFragment, doc: Document = document): string {
  const holder = doc.createElement('div');
  holder.appendChild(fragment);
  return holder.innerHTML;
}

/** The most times `sanitizeMarkup` cleans what its own answer parses into. */
const ROUNDS = 8;

/**
 * Markup without scripts, event handlers, script URLs or embedded browsing contexts, as a
 * string that is safe to parse again as the content of an element: what it parses into needs no
 * cleaning. Markup that never settles comes back empty. Prefer `sanitizeFragment` and the nodes
 * themselves wherever the result is put into a document.
 */
export function sanitizeMarkup(markup: string, doc: Document = document): string {
  let text = markup;
  for (let round = 0; round < ROUNDS; round++) {
    const fragment = parseFragment(text, doc);
    // Nothing to clean in what this string parses into: it is the answer.
    if (!cleanTree(fragment)) return text;
    text = serializeFragment(fragment, doc);
  }
  return '';
}

/** Cleans a parsed fragment in place. True when it took something out or changed a link. */
export function sanitizeFragment(fragment: DocumentFragment): boolean {
  return cleanTree(fragment);
}

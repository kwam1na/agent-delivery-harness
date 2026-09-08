/** Fixed, hash-authorized enhancement. No executor content enters this script. */
export const RUN_LIVE_SCRIPT = String.raw`(() => {
  const root = document.querySelector('main');
  const toggle = document.querySelector('[data-live-toggle]');
  const status = document.querySelector('[data-live-status]');
  if (!root || !toggle || !status) return;
  let paused = false;
  let timer;
  let interactingUntil = 0;
  const interval = Number(root.dataset.pollSeconds) * 1000;
  const interact = () => { interactingUntil = Date.now() + 1500; };
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(event, interact, { passive: true });
  }
  toggle.addEventListener('click', event => {
    event.preventDefault();
    paused = !paused;
    toggle.textContent = paused ? 'Resume live updates' : 'Pause updates';
    status.textContent = paused ? 'Updates paused' : 'Live';
  });
  // Preserve existing nodes wherever possible, including focused controls and
  // native disclosure state. Stable keys keep newly inserted cards from taking
  // the identity of an earlier card the operator is reading.
  const key = node => node.nodeType === 1 ? node.id || node.getAttribute('data-key') : null;
  function patch(current, next) {
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      current.replaceWith(next.cloneNode(true));
      return;
    }
    if (current.nodeType !== 1) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    if (current.hasAttribute('data-live-controls')) return;
    for (const attr of [...current.attributes]) {
      if (current.tagName === 'DETAILS' && attr.name === 'open') continue;
      if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of next.attributes) {
      if (current.tagName !== 'DETAILS' || attr.name !== 'open') current.setAttribute(attr.name, attr.value);
    }
    const children = [...current.childNodes];
    const used = new Set();
    let cursor = current.firstChild;
    for (const incoming of next.childNodes) {
      const incomingKey = key(incoming);
      const existing = incomingKey
        ? children.find(child => !used.has(child) && key(child) === incomingKey)
        : children.find(child => !used.has(child) && !key(child) && child.nodeType === incoming.nodeType && child.nodeName === incoming.nodeName);
      if (existing) {
        used.add(existing);
        if (existing !== cursor) current.insertBefore(existing, cursor);
        patch(existing, incoming);
        cursor = existing.nextSibling;
      } else {
        const added = incoming.cloneNode(true);
        current.insertBefore(added, cursor);
      }
    }
    for (const child of children) if (!used.has(child)) child.remove();
  }
  const busy = () => Date.now() < interactingUntil || !window.getSelection()?.isCollapsed;
  async function poll() {
    if (paused || document.hidden || busy()) {
      timer = setTimeout(poll, interval);
      return;
    }
    try {
      const response = await fetch(location.pathname, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('read');
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = page.querySelector('main');
      if (!next) throw Error('read');
      if (paused || document.hidden || busy()) { timer = setTimeout(poll, interval); return; }
      const focused = document.activeElement;
      if (focused && focused !== document.body && !focused.closest('[data-live-controls]')) {
        const context = focused.closest('[id], [data-key]');
        const replacement = context && [...next.querySelectorAll('[id], [data-key]')].find(element => key(element) === key(context));
        // A completed attempt may move into collapsed history. Keep the current
        // reading snapshot until focus leaves it, rather than removing the
        // focused control or presenting a stale duplicate as current work.
        if (!replacement || context.closest('section')?.id !== replacement.closest('section')?.id) {
          status.textContent = 'New update ready · Finish reading to apply';
          timer = setTimeout(poll, interval);
          return;
        }
      }
      const anchor = [...root.querySelectorAll('[id], [data-key]')].find(element => element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().top < window.innerHeight && element.getBoundingClientRect().height > 0);
      const offset = anchor?.getBoundingClientRect().top;
      const scroll = window.scrollY;
      patch(root, next);
      if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
      if (anchor?.isConnected && offset !== undefined) window.scrollBy(0, anchor.getBoundingClientRect().top - offset);
      else window.scrollTo(0, scroll);
      status.textContent = next.dataset.live === 'true' ? 'Live' : 'Saved observations';
      if (next.dataset.live !== 'true') { toggle.hidden = true; return; }
    } catch { status.textContent = 'Update unavailable · Retrying'; }
    timer = setTimeout(poll, interval);
  }
  timer = setTimeout(poll, interval);
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
})();`;

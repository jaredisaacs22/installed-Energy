// Videos: short films, reached only from the header's More menu. Each film is a self-contained page under
// assets/videos/, shown in a same-origin iframe (its own styles and keyboard controls stay inside it) that
// grows to the film's height. #/videos?v=<id> opens a given film (the first by default).
import { h } from '../ui.js';

export const VIDEOS = [
  { id: 'the-peak', title: 'The Peak', src: 'assets/videos/the-peak.html', about: 'A short film for a rural electric co-op: how rented, well-placed battery storage lets it say yes to a 100 MW data center without buying for the peak. 1 min 34 s, with captions and chapters.' },
];

export function renderVideos(root, data, params) {
  const pick = VIDEOS.find((v) => v.id === params?.get('v')) || VIDEOS[0];
  const frame = h('iframe', { class: 'video-frame', src: pick.src, title: `${pick.title} (film)` });
  frame.addEventListener('load', () => fitToContent(frame));
  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('span', { class: 'eyebrow' }, 'Videos'), h('h1', {}, pick.title), h('p', {}, pick.about)),
      h('div', { class: 'btn-row' }, h('a', { class: 'btn small', href: pick.src, target: '_blank', rel: 'noopener' }, 'Open full screen')),
    ),
    frame,
  );
}

/** Size the iframe to the film page so there is one scrollbar (the site's), not two. */
function fitToContent(frame) {
  let doc;
  try {
    doc = frame.contentDocument;
  } catch {
    return; // not same-origin (opened elsewhere): keep the CSS height
  }
  const win = frame.contentWindow;
  if (!doc?.body || !win) return;
  const fit = () => {
    const cs = win.getComputedStyle(doc.body);
    frame.style.height = `${Math.ceil(doc.body.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom))}px`;
  };
  fit();
  if (win.ResizeObserver) new win.ResizeObserver(fit).observe(doc.body);
}

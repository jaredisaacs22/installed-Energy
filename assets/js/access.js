// Access gate: visitors must sign in with an email address on an allowed domain before the app loads.
//
// IMPORTANT: GitHub Pages is static hosting, so this check runs in the browser. It keeps casual visitors
// out but is NOT security: anyone can type an address on the domain, and the files under data/ are
// still publicly downloadable. For enforced access (verified email one-time codes), put the site behind
// Cloudflare Access or a similar proxy — see docs/ACCESS.md. Site inputs and portfolios never leave the
// visitor's browser.

import { h, storage } from './ui.js';

/** Edit this list to change who can sign in (lowercase, without the @). */
export const ALLOWED_DOMAINS = ['sunbeltrentals.com'];

const KEY = 'atlas.session';
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `email` is well-formed and its domain exactly matches an allowed domain. */
export function isAllowedEmail(email, domains = ALLOWED_DOMAINS) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return false;
  const domain = e.slice(e.lastIndexOf('@') + 1);
  return domains.includes(domain);
}

export function currentSession() {
  const s = storage.get(KEY, null);
  if (!s || !isAllowedEmail(s.email) || !(s.expires > Date.now())) return null;
  return s;
}

export function signOut() {
  storage.del(KEY);
  location.reload();
}

/** Resolves once the visitor has a valid session (shows the sign-in screen if needed). */
export function requireSignIn(container) {
  const existing = currentSession();
  if (existing) return Promise.resolve(existing);
  document.body.classList.add('gated');
  return new Promise((resolve) => {
    const err = h('div', { class: 'gate-error', role: 'alert' });
    const input = h('input', { type: 'email', id: 'gate-email', autocomplete: 'email', required: true, placeholder: `name@${ALLOWED_DOMAINS[0]}`, 'aria-describedby': 'gate-help' });
    const form = h(
      'form',
      {
        class: 'gate-card card',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          const email = input.value.trim().toLowerCase();
          if (!isAllowedEmail(email)) {
            err.textContent = EMAIL_RE.test(email)
              ? `Access is limited to ${ALLOWED_DOMAINS.map((d) => '@' + d).join(', ')} email addresses.`
              : 'Enter a valid email address.';
            input.setAttribute('aria-invalid', 'true');
            input.focus();
            return;
          }
          const session = { email, at: Date.now(), expires: Date.now() + SESSION_DAYS * 864e5 };
          storage.set(KEY, session);
          document.body.classList.remove('gated');
          container.replaceChildren();
          resolve(session);
        },
      },
      h('div', { class: 'brand-mark gate-mark', 'aria-hidden': 'true', html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M10 2h4"/><path d="M13 8l-3 5h4l-2 4"/></svg>' }),
      h('h1', {}, 'BESS Incentive Atlas'),
      h('p', { class: 'ink2' }, 'Sign in with your company email to continue.'),
      h('div', { class: 'field' }, h('label', { for: 'gate-email' }, 'Work email'), input),
      err,
      h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', justifyContent: 'center' } }, 'Continue'),
      h('p', { id: 'gate-help', class: 'small muted', style: { marginTop: '12px' } }, `Access is limited to ${ALLOWED_DOMAINS.map((d) => '@' + d).join(', ')} addresses. Anything you enter about sites stays in this browser.`),
    );
    container.replaceChildren(h('div', { class: 'gate' }, form));
    setTimeout(() => input.focus(), 0);
  });
}

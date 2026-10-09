// Staff / admin UI language (ไทย / English).
// When Thai is selected, a MutationObserver swaps exact English UI strings (text, placeholder, title,
// aria-label) for their Thai equivalents from adminTh.js as React renders them. Only known UI strings are
// touched, so member names, notes, numbers and receipts (marked translate="no") are left as they are.
import { useEffect } from 'react';
import { Languages } from 'lucide-react';
import { tr } from './adminTh.js';

const KEY = 'sc.admin.lang';
const ATTRS = ['placeholder', 'title', 'aria-label'];
const SKIP = 'script,style,textarea,code,pre,[translate="no"],.notranslate,[contenteditable="true"]';

export function getAdminLang() {
  try { return localStorage.getItem(KEY) || 'th'; } catch { return 'th'; }
}

export function setAdminLang(lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* storage unavailable: applies to this page only */ }
  location.reload();
}

function swap(value) {
  if (!value || !/[A-Za-z]/.test(value)) return null;
  const t = value.trim();
  const th = t && tr(t);
  if (!th || th === t) return null;
  const at = value.indexOf(t);
  return value.slice(0, at) + th + value.slice(at + t.length);
}

function translateText(node) {
  const p = node.parentElement;
  if (!p || p.closest(SKIP)) return;
  const v = swap(node.nodeValue);
  if (v != null) node.nodeValue = v;
}

function translateAttrs(el) {
  if (el.closest(SKIP)) return;
  for (const a of ATTRS) {
    const cur = el.getAttribute(a);
    const v = cur && swap(cur);
    if (v != null) el.setAttribute(a, v);
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) { translateText(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n);
    else translateAttrs(n);
  }
}

/** Mount once in the staff app. No-op unless the staff language is Thai. */
export function useAdminTranslation() {
  useEffect(() => {
    if (getAdminLang() !== 'th') return undefined;
    const prevLang = document.documentElement.lang;
    document.documentElement.lang = 'th';
    translateTree(document.body);
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') translateText(m.target);
        else if (m.type === 'attributes') translateAttrs(m.target);
        else m.addedNodes.forEach(translateTree);
      }
    });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    return () => { obs.disconnect(); document.documentElement.lang = prevLang; };
  }, []);
}

/** TH / EN toggle for staff screens. */
export function AdminLangToggle({ className = '' }) {
  const lang = getAdminLang();
  const next = lang === 'th' ? 'en' : 'th';
  return (
    <button type="button" className={`btn ghost sm ${className}`} translate="no" onClick={() => setAdminLang(next)}
      aria-label={lang === 'th' ? 'Switch to English' : 'เปลี่ยนเป็นภาษาไทย'} title={lang === 'th' ? 'Switch to English' : 'เปลี่ยนเป็นภาษาไทย'}>
      <Languages size={16} /> {lang === 'th' ? 'EN' : 'ไทย'}
    </button>
  );
}

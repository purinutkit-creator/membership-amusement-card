// API client. Cookies carry staff/member sessions; X-Requested-With is the CSRF guard.
// Device / display tokens are sent as Authorization headers by the device pages.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || 'ERROR';
    this.details = body?.error?.details;
  }
}

let approvalHandler = null;
/** Register the global "Manager approval" modal; it resolves {employeeCode, pin} or null. */
export function setApprovalHandler(fn) { approvalHandler = fn; }
let branchId = localStorage.getItem('sc.branch') || '';
export function setBranch(id) { branchId = id || ''; id ? localStorage.setItem('sc.branch', id) : localStorage.removeItem('sc.branch'); }
export function getBranch() { return branchId; }

export async function request(method, path, body, { headers = {}, raw = false, approval = true } = {}) {
  const h = { 'X-Requested-With': 'smartcard', ...headers };
  if (branchId) h['X-Branch-Id'] = branchId;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: h, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Cannot reach the server. Check your connection.' } });
  }
  if (raw) { if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({}))); return res; }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    // Manager approval: ask for credentials and retry once with them attached
    if (approval && err.code === 'APPROVAL_REQUIRED' && approvalHandler && body && !(body instanceof FormData)) {
      const creds = await approvalHandler({ message: err.message, permission: err.details?.permission });
      if (creds) return request(method, path, { ...body, approval: creds }, { headers, approval: false });
    }
    if (err.status === 401 && err.code === 'UNAUTHENTICATED') window.dispatchEvent(new CustomEvent('sc:unauthenticated', { detail: path }));
    throw err;
  }
  return data;
}

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b = {}, o) => request('POST', p, b, o),
  put: (p, b = {}, o) => request('PUT', p, b, o),
  del: (p, o) => request('DELETE', p, undefined, o),
  upload: (p, form) => request('POST', p, form),
};

export function qs(obj) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
}

/** Download a file endpoint (CSV/XLSX) through fetch so cookies & headers apply. */
export async function download(path, filename) {
  const res = await request('GET', path, undefined, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Client for device pages (terminal/kiosk/display) that authenticate with a token. */
export function tokenClient(scheme, getToken) {
  const call = (method, path, body) => request(method, path, body, { headers: getToken() ? { Authorization: `${scheme} ${getToken()}` } : {}, approval: false });
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}

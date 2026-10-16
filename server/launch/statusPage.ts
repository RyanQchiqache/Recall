import crypto from 'node:crypto';
import os from 'node:os';
import type { StartupState } from './probe.ts';

/** Everything the startup status page (and GET /api/startup) shows. */
export interface StartupStatus {
  app: 'recall';
  state: StartupState;
  /** Plain-language heading, e.g. "Rebuilding after an update…". */
  stage: string;
  /** One or two sentences under the heading. */
  message: string;
  startedAt: string;
  /** Time spent in the current state (server-measured, so client clocks do not matter). */
  elapsedMs: number;
  error: { summary: string; hint: string } | null;
  /** Last lines of the build or server output. */
  buildLog: string[];
  /** A previous build exists and can be opened although the new one failed. */
  canUsePrevious: boolean;
  usingPrevious: boolean;
  logPath: string;
  /** Plain-text report for "Copy details". */
  report: string;
  /** Served by the launcher because the server itself could not start. */
  launcher?: boolean;
}

export interface ReportDetails {
  version: string;
  dataDir: string;
  port: number;
  logPath: string;
  state: StartupState;
  stage: string;
  error: { summary: string; hint: string } | null;
  buildLog: string[];
  buildId?: string | null;
}

export function formatReport(d: ReportDetails): string {
  return [
    'Recall startup report',
    `Time:        ${new Date().toISOString()}`,
    `Version:     ${d.version}`,
    `Node.js:     ${process.version}`,
    `OS:          ${process.platform} ${process.arch} (${os.release()})`,
    `Data folder: ${d.dataDir}`,
    `Port:        ${d.port}`,
    `Log file:    ${d.logPath}`,
    `Build:       ${d.buildId ?? 'none'}`,
    `State:       ${d.state} (${d.stage})`,
    `Error:       ${d.error?.summary ?? 'none'}`,
    '',
    'Last output:',
    ...(d.buildLog.length ? d.buildLog : ['(none)']),
  ].join('\n');
}

export function newNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** CSP for the status page: only its own nonce-tagged inline script and style, and same-origin polling. */
export function statusPageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#4f46e5"/><rect x="14" y="20" width="30" height="22" rx="5" fill="#c7d2fe"/><rect x="20" y="24" width="30" height="22" rx="5" fill="#fff"/><path d="M28 35l4 4 8-9" fill="none" stroke="#4f46e5" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--surface:#fff;--surface-2:#f3f4f6;--border:#e5e7eb;--border-strong:#d1d5db;--text:#111827;--text-2:#374151;--muted:#6b7280;--primary:#2563eb;--primary-hover:#1d4ed8;--primary-soft:#eef3fe;--focus:#3b82f6;--danger:#dc2626;--danger-soft:#fef2f2;--code-bg:#f6f7f9}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f12;--surface:#16171b;--surface-2:#1c1d22;--border:#26282e;--border-strong:#33363d;--text:#ececef;--text-2:#c9cbd1;--muted:#8e9199;--primary:#3b82f6;--primary-hover:#2563eb;--primary-soft:#172036;--focus:#3b82f6;--danger:#f87171;--danger-soft:#2a1416;--code-bg:#1c1d22}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--text);font:400 15px/1.55 "Inter Variable",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px 16px}
main{width:100%;max-width:560px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;box-shadow:0 1px 2px rgba(17,24,39,.04)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px;color:var(--text-2);font-weight:600;font-size:14px}
.brand img{width:28px;height:28px}
h1{font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
p{margin:0;color:var(--text-2)}
.muted{color:var(--muted);font-size:13px}
.bar{height:4px;border-radius:9999px;background:var(--surface-2);overflow:hidden;margin:20px 0 4px}
.bar span{display:block;height:100%;width:35%;border-radius:9999px;background:var(--primary);animation:slide 1.4s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
.alert{margin-top:16px;padding:12px 14px;border-radius:8px;background:var(--danger-soft);border:1px solid color-mix(in srgb,var(--danger) 30%,transparent);color:var(--text)}
.alert strong{display:block;font-weight:600;margin-bottom:2px;color:var(--danger)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
button{font:inherit;font-size:14px;font-weight:500;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;box-shadow:0 1px 2px rgba(17,24,39,.04)}
button:hover{background:var(--surface-2);border-color:var(--border-strong)}
button:active{transform:translateY(1px)}
button.primary{background:var(--primary);border-color:var(--primary);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(17,24,39,.04)}
button.primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
button:disabled{opacity:.6;cursor:default}
button:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
details{margin-top:16px}
summary{cursor:pointer;color:var(--text-2);font-size:13px;font-weight:500;border-radius:6px}
pre{margin:8px 0 0;max-height:240px;overflow:auto;padding:10px 12px;border-radius:8px;background:var(--code-bg);border:1px solid var(--border);font:400 11px/1.6 "JetBrains Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:var(--text-2)}
.note{margin-top:12px;min-height:1.4em}
h2.sub{margin:16px 0 0;font-weight:500;font-size:13px;color:var(--muted)}
#log-path{margin-top:12px;word-break:break-all}
.elapsed{font-variant-numeric:tabular-nums;margin-left:4px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.bar span{animation:none;width:100%;opacity:.35}button:active{transform:none}}
`;

/**
 * Client script. Plain ES2017 so it runs in any browser Recall supports, with no external requests.
 * It polls GET /api/startup and reloads once the app is ready.
 */
const SCRIPT = `
(function(){
  var data = JSON.parse(document.getElementById('recall-status').textContent);
  var $ = function(id){ return document.getElementById(id); };
  var received = Date.now(), failures = 0, done = false, firstFailure = 0;
  var H = {'x-recall-client':'1','content-type':'application/json'};
  function secs(){ return Math.max(0, Math.round((data.elapsedMs + Date.now() - received) / 1000)); }
  function setText(id, t){ var e = $(id); if (e.textContent !== t) e.textContent = t; }
  function render(){
    var failed = data.state === 'failed';
    setText('stage', data.stage);
    // Elapsed time lives outside the aria-live region so screen readers are not interrupted every second.
    setText('elapsed', data.state === 'building' ? secs() + ' s elapsed' : '');
    setText('message', data.message);
    $('progress').hidden = failed;
    $('failure').hidden = !failed;
    if (failed && data.error) { setText('error-summary', data.error.summary); setText('error-hint', data.error.hint); }
    var log = (data.buildLog || []).join('\\n');
    $('log-box').hidden = !log;
    setText('log', log);
    $('previous').hidden = !(failed && data.canUsePrevious);
    setText('log-path', data.logPath ? 'Log file: ' + data.logPath : '');
    document.title = failed ? 'Recall could not start' : 'Starting Recall';
  }
  function offline(){
    if (!firstFailure) firstFailure = Date.now();
    if (Date.now() - firstFailure < 15000) {
      setText('stage', 'Starting Recall'); setText('message', 'Waiting for Recall to answer…');
    } else {
      setText('stage', 'Recall is not responding');
      setText('message', 'Recall stopped unexpectedly or is still starting. If this does not change, close this tab and open Recall again.');
    }
    setText('elapsed', '');
    $('progress').hidden = false; $('failure').hidden = true; $('previous').hidden = true;
  }
  function apply(s){
    data = s; received = Date.now(); failures = 0; firstFailure = 0;
    if (s.state === 'ready') {
      done = true; setText('stage', 'Opening Recall'); setText('message', 'Recall is ready.');
      $('progress').hidden = false; $('failure').hidden = true;
      location.reload();
      return;
    }
    render();
  }
  function poll(){
    if (done) return;
    fetch('/api/startup', {cache:'no-store', headers:{'accept':'application/json'}})
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(apply)
      .catch(function(){ failures++; offline(); })
      .then(function(){ if (!done) setTimeout(poll, 500); });
  }
  function note(t){ setText('note', t); }
  function post(url){
    return fetch(url, {method:'POST', headers:H, body:'{}', cache:'no-store'}).then(function(r){
      return r.json().then(function(j){ if (!r.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status)); return j; });
    });
  }
  $('retry').addEventListener('click', function(){
    var b = this; b.disabled = true; note('Trying again…');
    post('/api/startup/retry').then(function(s){ note(''); if (s && s.state) apply(s); })
      .catch(function(){ note(''); offline(); })
      .then(function(){ b.disabled = false; });
  });
  $('open-log').addEventListener('click', function(){
    post('/api/startup/open-log').then(function(){ note('The log opened in another window.'); })
      .catch(function(e){ note('Could not open the log (' + e.message + '). ' + (data.logPath ? 'It is at ' + data.logPath : '')); });
  });
  $('copy').addEventListener('click', function(){
    var text = data.report || '';
    function fallback(){
      var t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', '');
      t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(t);
      if (ok) note('Details copied to the clipboard.');
      else { $('log-box').hidden = false; $('log-box').open = true; setText('log', text); note('Copying is blocked here. Select the details below and copy them by hand.'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function(){ note('Details copied to the clipboard.'); }, fallback);
    else fallback();
  });
  $('use-previous').addEventListener('click', function(){
    post('/api/startup/use-previous').then(apply).catch(function(e){ note(e.message); });
  });
  render();
  setInterval(function(){ if (!done && data.state === 'building') render(); }, 1000);
  setTimeout(poll, data.state === 'failed' ? 1500 : 300);
})();
`;

/** Self-contained startup page: inline CSS and JS only, no external requests. */
export function renderStatusPage(status: StartupStatus, nonce: string): string {
  const failed = status.state === 'failed';
  const json = JSON.stringify(status).replace(/</g, '\\u003c');
  const log = status.buildLog.join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${failed ? 'Recall could not start' : 'Starting Recall'}</title>
<link rel="icon" href="${ICON}">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
  <div class="card" role="region" aria-labelledby="stage">
    <div class="brand"><img src="${ICON}" alt="" width="28" height="28">Recall</div>
    <div aria-live="polite" aria-atomic="true">
      <h1 id="stage">${esc(status.stage)}</h1>
      <p id="message">${esc(status.message)}</p>
    </div>
    <div id="progress"${failed ? ' hidden' : ''}>
      <div class="bar" aria-hidden="true"><span></span></div>
      <p class="muted">This page continues by itself once Recall is ready. <span id="elapsed" class="elapsed"></span></p>
    </div>
    <section id="failure" aria-labelledby="failure-title"${failed ? '' : ' hidden'}>
      <div class="alert" role="alert">
        <strong id="failure-title">What went wrong</strong>
        <span id="error-summary">${esc(status.error?.summary ?? '')}</span>
      </div>
      <p class="note" id="error-hint">${esc(status.error?.hint ?? '')}</p>
      <h2 class="sub">What you can do</h2>
      <div class="actions">
        <button type="button" class="primary" id="retry">Retry</button>
        <span id="previous"${failed && status.canUsePrevious ? '' : ' hidden'}><button type="button" id="use-previous">Open the previous version</button></span>
        <button type="button" id="open-log">Open log</button>
        <button type="button" id="copy">Copy details</button>
      </div>
      <p class="muted" id="log-path">${status.logPath ? esc(`Log file: ${status.logPath}`) : ''}</p>
    </section>
    <details id="log-box"${log ? '' : ' hidden'}>
      <summary>Show technical details</summary>
      <pre id="log">${esc(log)}</pre>
    </details>
    <p class="muted note" id="note" role="status" aria-live="polite"></p>
  </div>
</main>
<script type="application/json" id="recall-status">${json}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

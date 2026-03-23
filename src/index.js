/**
 * Cloudflare Worker — Dynamic PAC File Host
 *
 * Routes:
 *   GET  /<endpoint-id>.pac   Always works. Substitutes <endpoint-id> into the
 *                             stored PAC template and returns the PAC file.
 *   GET  /proxy.pac           Returns the PAC file using the fixed endpoint ID
 *                             configured in admin, only when publishMode is
 *                             "proxy_pac". Returns 404 otherwise.
 *   GET  /admin               Admin UI (unauthenticated) for editing the PAC
 *                             template and publish settings.
 *   POST /admin               Saves template + config to KV, then redirects
 *                             back to /admin.
 *
 * KV keys (binding: PAC_STORE):
 *   pac_template   PAC JS text containing {{ENDPOINT_ID}} placeholder.
 *   config         JSON: { publishMode, endpointId, randomId }
 */

// ---------------------------------------------------------------------------
// Default PAC template — stored in KV, fully editable via /admin.
// Follows Cloudflare's recommended best practices:
//   - DNS result cached in a variable (avoids redundant dnsResolve() calls)
//   - Plain hostnames bypass proxy (NetBIOS / intranet)
//   - RFC 1918 private ranges bypass proxy
//   - Uses HTTPS directive (required; PROXY does not work for modern browsers)
// ---------------------------------------------------------------------------
const DEFAULT_TEMPLATE = `function FindProxyForURL(url, host) {
  // Cache DNS resolution to avoid redundant lookups (performance best practice)
  var hostIP = dnsResolve(host);

  // Bypass plain hostnames (NetBIOS / intranet)
  if (isPlainHostName(host)) return "DIRECT";

  // Bypass private RFC 1918 IP addresses
  if (
    isInNet(hostIP, "10.0.0.0", "255.0.0.0") ||
    isInNet(hostIP, "172.16.0.0", "255.240.0.0") ||
    isInNet(hostIP, "192.168.0.0", "255.255.0.0")
  ) return "DIRECT";

  // Bypass localhost
  if (isInNet(hostIP, "127.0.0.0", "255.0.0.0")) return "DIRECT";

  // Proxy all other traffic via Cloudflare Gateway
  return "HTTPS {{ENDPOINT_ID}}.proxy.cloudflare-gateway.com:443";
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a 10-character lowercase alphanumeric ID (e.g. "9norvypvo8"). */
function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/** Escape HTML special characters for safe inline rendering. */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Retrieve the stored PAC template, falling back to the built-in default. */
async function getTemplate(env) {
  return (await env.PAC_STORE.get('pac_template')) ?? DEFAULT_TEMPLATE;
}

/**
 * Retrieve the stored publish config.
 * If no config has been saved yet, returns a default with a freshly generated
 * randomId. This default is NOT persisted until the admin saves it.
 */
async function getConfig(env) {
  const raw = await env.PAC_STORE.get('config');
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupted KV value — fall through to default.
    }
  }
  return { publishMode: 'random_id', endpointId: '', randomId: generateId() };
}

/**
 * Replace every occurrence of {{ENDPOINT_ID}} in the template with endpointId.
 */
function buildPac(template, endpointId) {
  return template.replace(/\{\{ENDPOINT_ID\}\}/g, endpointId);
}

/** Return a Response with the correct MIME type and no-cache headers for PAC. */
function pacResponse(content) {
  return new Response(content, {
    headers: {
      'Content-Type': 'application/x-ns-proxy-autoconfig',
      // Prevent browsers from caching stale PAC files after an update.
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
    },
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /<id>.pac — dynamic PAC with the endpoint ID taken from the URL path. */
async function handleDynamicPac(env, endpointId) {
  const template = await getTemplate(env);
  return pacResponse(buildPac(template, endpointId));
}

/**
 * GET /proxy.pac — serves the PAC file only when publishMode is "proxy_pac"
 * and a fixed endpoint ID has been configured.
 */
async function handleProxyPac(env) {
  const config = await getConfig(env);
  if (config.publishMode !== 'proxy_pac' || !config.endpointId) {
    return new Response('Not Found\n\nProxy PAC mode is not enabled. Visit /admin to configure.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  const template = await getTemplate(env);
  return pacResponse(buildPac(template, config.endpointId));
}

/** GET /admin — render the admin UI. */
async function handleAdminGet(env, requestUrl) {
  const [template, config] = await Promise.all([getTemplate(env), getConfig(env)]);
  return new Response(renderAdminHtml(template, config, requestUrl.origin), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** POST /admin — persist template + config to KV, then redirect to /admin. */
async function handleAdminPost(request, env, requestUrl) {
  const form = await request.formData();

  const template  = form.get('template')    ?? DEFAULT_TEMPLATE;
  const publishMode = form.get('publishMode') ?? 'random_id';
  const endpointId  = (form.get('endpointId') ?? '').trim();
  const randomId    = (form.get('randomId')   ?? generateId()).trim() || generateId();

  await Promise.all([
    env.PAC_STORE.put('pac_template', template),
    env.PAC_STORE.put('config', JSON.stringify({ publishMode, endpointId, randomId })),
  ]);

  return Response.redirect(requestUrl.origin + '/admin', 303);
}

// ---------------------------------------------------------------------------
// Admin UI
// ---------------------------------------------------------------------------

function renderAdminHtml(template, config, origin) {
  const proxyPacActive = config.publishMode === 'proxy_pac';
  const randomIdActive  = !proxyPacActive;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PAC File Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f4f4f5;
      color: #18181b;
      padding: 2rem 1rem;
      line-height: 1.5;
    }

    .container { max-width: 880px; margin: 0 auto; }

    .page-header { margin-bottom: 2rem; }
    .page-header h1 { font-size: 1.4rem; font-weight: 700; display: flex; align-items: center; gap: 0.6rem; }
    .page-header p { color: #52525b; font-size: 0.875rem; margin-top: 0.3rem; }

    .badge {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      background: #fef9c3;
      color: #854d0e;
      border: 1px solid #fde047;
      border-radius: 999px;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      vertical-align: middle;
    }

    .card {
      background: #fff;
      border: 1px solid #e4e4e7;
      border-radius: 10px;
      padding: 1.5rem;
      margin-bottom: 1.25rem;
    }
    .card-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: #18181b;
      margin-bottom: 1rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid #f4f4f5;
    }

    label.field-label {
      display: block;
      font-size: 0.8rem;
      font-weight: 500;
      color: #3f3f46;
      margin-bottom: 0.4rem;
    }
    .hint {
      font-size: 0.75rem;
      color: #71717a;
      margin-top: 0.35rem;
    }

    textarea {
      width: 100%;
      height: 300px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.78rem;
      line-height: 1.6;
      padding: 0.75rem;
      border: 1px solid #d4d4d8;
      border-radius: 6px;
      resize: vertical;
      background: #fafafa;
      color: #18181b;
      tab-size: 2;
    }
    textarea:focus { outline: none; border-color: #f97316; box-shadow: 0 0 0 3px rgba(249,115,22,0.15); }

    input[type="text"] {
      width: 100%;
      padding: 0.45rem 0.7rem;
      border: 1px solid #d4d4d8;
      border-radius: 6px;
      font-size: 0.875rem;
      background: #fff;
      color: #18181b;
    }
    input[type="text"]:focus { outline: none; border-color: #f97316; box-shadow: 0 0 0 3px rgba(249,115,22,0.15); }

    .radio-group {
      display: flex;
      gap: 2rem;
      margin-bottom: 1.25rem;
    }
    .radio-option {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
    }
    .radio-option input[type="radio"] { cursor: pointer; accent-color: #f97316; }

    .sub-section {
      padding: 1rem;
      background: #f9f9fa;
      border: 1px solid #e4e4e7;
      border-radius: 6px;
    }
    .sub-section + .sub-section { margin-top: 0.75rem; }

    .id-row { display: flex; gap: 0.5rem; align-items: stretch; }
    .id-row input { flex: 1; }

    .preview-box {
      margin-top: 0.75rem;
      padding: 0.6rem 0.75rem;
      background: #f4f4f5;
      border: 1px solid #e4e4e7;
      border-radius: 5px;
    }
    .preview-box .preview-label {
      font-size: 0.68rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #a1a1aa;
      margin-bottom: 0.25rem;
    }
    .preview-box code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.78rem;
      color: #18181b;
      word-break: break-all;
    }

    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.82em;
      background: #f4f4f5;
      padding: 0.1em 0.35em;
      border-radius: 3px;
    }

    .note {
      margin-top: 1rem;
      padding: 0.65rem 0.85rem;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 6px;
      font-size: 0.78rem;
      color: #1e40af;
    }

    button {
      cursor: pointer;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.45rem 0.9rem;
      border: 1px solid #d4d4d8;
      background: #fff;
      color: #3f3f46;
      transition: background 0.1s;
    }
    button:hover { background: #f4f4f5; }

    .btn-save {
      background: #f97316;
      color: #fff;
      border-color: #f97316;
      font-weight: 600;
      padding: 0.55rem 1.75rem;
      font-size: 0.925rem;
    }
    .btn-save:hover { background: #ea6c10; border-color: #ea6c10; }

    .actions { display: flex; justify-content: flex-end; margin-top: 1.5rem; }
  </style>
</head>
<body>
<div class="container">

  <div class="page-header">
    <h1>PAC File Admin <span class="badge">unauthenticated</span></h1>
    <p>Manage your Cloudflare Gateway PAC file template and publish settings.</p>
  </div>

  <form method="POST" action="/admin" id="adminForm">

    <!-- ── PAC Template ─────────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">PAC Template</div>
      <label class="field-label" for="template">
        <code>FindProxyForURL</code> function — use <code>{{ENDPOINT_ID}}</code> as the Cloudflare Proxy Endpoint ID placeholder.
      </label>
      <textarea name="template" id="template" spellcheck="false" autocorrect="off" autocapitalize="off">${escapeHtml(template)}</textarea>
      <p class="hint">
        The <code>{{ENDPOINT_ID}}</code> placeholder is substituted at request time.
        Use <code>HTTPS</code> (not <code>PROXY</code>) — required for modern browsers.
      </p>
    </div>

    <!-- ── Publish Settings ──────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">Publish Settings</div>

      <div class="radio-group">
        <label class="radio-option">
          <input type="radio" name="publishMode" value="proxy_pac" id="mode-proxy" ${proxyPacActive ? 'checked' : ''}>
          Publish at <code>/proxy.pac</code>
        </label>
        <label class="radio-option">
          <input type="radio" name="publishMode" value="random_id" id="mode-random" ${randomIdActive ? 'checked' : ''}>
          Use a random ID path
        </label>
      </div>

      <!-- proxy.pac mode -->
      <div class="sub-section" id="proxy-pac-section" style="${proxyPacActive ? '' : 'display:none'}">
        <label class="field-label" for="endpointId">Cloudflare Proxy Endpoint ID</label>
        <input type="text" name="endpointId" id="endpointId"
               value="${escapeHtml(config.endpointId)}"
               placeholder="e.g. 9norvypvo8">
        <p class="hint">The endpoint ID to use in the proxy server line for <code>/proxy.pac</code>.</p>
        <div class="preview-box">
          <div class="preview-label">Proxy server line</div>
          <code id="proxy-pac-line">HTTPS ${escapeHtml(config.endpointId || 'your-endpoint-id')}.proxy.cloudflare-gateway.com:443</code>
        </div>
        <div class="preview-box">
          <div class="preview-label">PAC file URL</div>
          <code>${escapeHtml(origin)}/proxy.pac</code>
        </div>
      </div>

      <!-- random ID mode -->
      <div class="sub-section" id="random-id-section" style="${randomIdActive ? '' : 'display:none'}">
        <label class="field-label">Random Endpoint ID</label>
        <div class="id-row">
          <input type="text" name="randomId" id="randomId"
                 value="${escapeHtml(config.randomId)}"
                 placeholder="10-char alphanumeric"
                 maxlength="63">
          <button type="button" id="btn-regen">Regenerate</button>
        </div>
        <p class="hint">
          The PAC file is served at <code>/<em>id</em>.pac</code> and the <code>{{ENDPOINT_ID}}</code>
          placeholder in the template is replaced with this same ID, so the proxy server URL matches automatically.
        </p>
        <div class="preview-box">
          <div class="preview-label">PAC file URL</div>
          <code>${escapeHtml(origin)}/<span id="random-id-display">${escapeHtml(config.randomId)}</span>.pac</code>
        </div>
        <div class="preview-box">
          <div class="preview-label">Proxy server line</div>
          <code>HTTPS <span id="random-proxy-display">${escapeHtml(config.randomId)}</span>.proxy.cloudflare-gateway.com:443</code>
        </div>
      </div>

      <div class="note">
        <strong>Note:</strong> <code>/<em>any-id</em>.pac</code> always works dynamically —
        the endpoint ID is taken directly from the URL path regardless of the setting above.
        The setting above only controls which <em>fixed URL</em> is additionally published.
      </div>
    </div>

    <div class="actions">
      <button type="submit" class="btn-save">Save Changes</button>
    </div>

  </form>
</div>

<script>
  // ── Toggle sections based on publish mode ──────────────────────────────
  document.querySelectorAll('input[name="publishMode"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      document.getElementById('proxy-pac-section').style.display =
        this.value === 'proxy_pac' ? '' : 'none';
      document.getElementById('random-id-section').style.display =
        this.value === 'random_id' ? '' : 'none';
    });
  });

  // ── Live preview: proxy.pac endpoint ID ───────────────────────────────
  document.getElementById('endpointId').addEventListener('input', function () {
    var id = this.value.trim() || 'your-endpoint-id';
    document.getElementById('proxy-pac-line').textContent =
      'HTTPS ' + id + '.proxy.cloudflare-gateway.com:443';
  });

  // ── Live preview: random ID ────────────────────────────────────────────
  document.getElementById('randomId').addEventListener('input', function () {
    var id = this.value.trim() || 'your-id';
    document.getElementById('random-id-display').textContent = id;
    document.getElementById('random-proxy-display').textContent = id;
  });

  // ── Regenerate button ──────────────────────────────────────────────────
  document.getElementById('btn-regen').addEventListener('click', function () {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var bytes = new Uint8Array(10);
    window.crypto.getRandomValues(bytes);
    var id = Array.from(bytes, function (b) { return chars[b % chars.length]; }).join('');
    var input = document.getElementById('randomId');
    input.value = id;
    input.dispatchEvent(new Event('input'));
  });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    try {
      if (method === 'GET') {
        if (path === '/admin')      return handleAdminGet(env, url);
        if (path === '/proxy.pac')  return handleProxyPac(env);

        // /<endpoint-id>.pac  — alphanumeric IDs only
        const pacMatch = path.match(/^\/([a-zA-Z0-9][-a-zA-Z0-9]*)\.pac$/);
        if (pacMatch) return handleDynamicPac(env, pacMatch[1]);
      }

      if (method === 'POST' && path === '/admin') {
        return handleAdminPost(request, env, url);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('Worker error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

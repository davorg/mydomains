const STORAGE_KEY = 'domainInventory.v1';

let state = {
  version: 1,
  domains: []
};

let currentDetailId = null;
let editingId = null;

// ---------- Core state helpers ----------

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.domains)) {
      state = parsed;
    }
  } catch (e) {
    console.error('Failed to parse stored state', e);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function setStatus(msg) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  if (msg) {
    setTimeout(() => { el.textContent = ''; }, 5000);
  }
}

// Simple HTML escapey
function escapeHtml(str) {
  return (str || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- DNS / hosting helpers ----------

// You can tweak / expand these ranges, they’re just common CF blocks
function isCloudflareIp4(ip) {
  return (
    ip.startsWith('104.')      || // 104.16.0.0/12 etc.
    ip.startsWith('172.64.')   ||
    ip.startsWith('172.65.')   ||
    ip.startsWith('172.66.')   ||
    ip.startsWith('172.67.')   ||
    ip.startsWith('188.114.')  ||
    ip.startsWith('190.93.')   ||
    ip.startsWith('198.41.')   ||
    ip.startsWith('141.101.')  ||
    ip.startsWith('162.158.')  ||
    ip.startsWith('108.162.')
  );
}

function isCloudflareIp6(ip) {
  return (
    ip.startsWith('2400:cb00:') ||
    ip.startsWith('2606:4700:') ||
    ip.startsWith('2803:f800:') ||
    ip.startsWith('2405:b500:') ||
    ip.startsWith('2405:8100:') ||
    ip.startsWith('2c0f:f248:') ||
    ip.startsWith('2a06:98c0:')
  );
}

function isCloudflareEdge(rec) {
  const a = rec.a || [];
  const aaaa = rec.aaaa || [];
  return (
    a.some(isCloudflareIp4) ||
    aaaa.some(isCloudflareIp6)
  );
}

function guessDnsProvider(nsList) {
  const nsLower = (nsList || []).map(n => n.toLowerCase());
  if (nsLower.some(n => n.includes('cloudflare.com'))) {
    return 'Cloudflare';
  }
  // Route 53 names look like ns-1234.awsdns-56.org / .com / .net etc.
  if (nsLower.some(n => n.includes('awsdns'))) {
    return 'AWS Route 53';
  }
  // Gandi: typically a.dns.gandi.net / b.dns.gandi.net etc.
  if (nsLower.some(n => n.includes('gandi.net'))) {
    return 'Gandi';
  }
  return 'Unknown';
}

// TODO: fill with your real VPS IPs if you want IONOS detection
const KNOWN_IONOS_IPS = [
  '194.164.18.35'
];

function guessHostingProvider(fqdn, rec) {
  if (!rec) return 'Unknown';

  const cname = (rec.cname || '').toLowerCase();
  const aRecords = rec.a || [];
  const aaaaRecords = rec.aaaa || [];

  // We'll build up a "base" provider, then possibly wrap it with "(via Cloudflare)"
  let provider = 'Unknown';

  // --- Gandi web redirection ---
  // It can appear as CNAME *or* in A/AAAA chains
  const allStrings = [
    cname,
    ...aRecords,
    ...aaaaRecords
  ].join(' ').toLowerCase();

  if (allStrings.includes('webredir.gandi.net')) {
    provider = 'Gandi web redirection';
  }

  // --- GitHub Pages ---
  if (provider === 'Unknown') {
    if (cname.endsWith('.github.io')) {
      provider = 'GitHub Pages';
    } else if (aRecords.some(ip =>
      ip.startsWith('185.199.108.') ||
      ip.startsWith('185.199.109.') ||
      ip.startsWith('185.199.110.') ||
      ip.startsWith('185.199.111.')
    )) {
      provider = 'GitHub Pages';
    }
  }

  // --- AWS / CloudFront / S3 ---
  if (provider === 'Unknown') {
    if (cname.endsWith('.cloudfront.net')) {
      provider = 'AWS (CloudFront)';
    } else if (cname.includes('.s3.amazonaws.com') || cname.includes('s3-website-')) {
      provider = 'AWS (S3)';
    }
  }

  // --- Google Cloud Run / Google-hosted ---
  if (provider === 'Unknown') {
    if (cname.endsWith('.a.run.app')) {
      provider = 'Google Cloud Run';
    } else if (cname === 'ghs.googlehosted.com') {
      provider = 'Google Cloud (managed)';
    }
  }

  // --- IONOS VPS (user-configured) ---
  if (provider === 'Unknown') {
    if (aRecords.some(ip => KNOWN_IONOS_IPS.includes(ip))) {
      provider = 'IONOS VPS';
    }
  }

  // --- Cloudflare edge wrapper ---
  if (isCloudflareEdge(rec)) {
    if (provider !== 'Unknown' && !provider.includes('(via Cloudflare)')) {
      return `${provider} (via Cloudflare)`;
    }
    return 'Unknown (via Cloudflare)';
  }

  return provider;
}

function getExpiryClass(dom) {
  const rdap = dom.cache && dom.cache.rdap;
  if (!rdap || !rdap.expires) {
    return ''; // no colouring if we don't know
  }

  const expDate = new Date(rdap.expires);
  const now = new Date();

  if (isNaN(expDate.getTime())) {
    return '';
  }

  // Expired
  if (expDate < now) {
    return 'expiry-expired';
  }

  // Within the next month
  const oneMonthAhead = new Date(now);
  oneMonthAhead.setMonth(now.getMonth() + 1);
  if (expDate <= oneMonthAhead) {
    return 'expiry-soon';
  }

  // More than a month away
  return 'expiry-ok';
}

// ---------- Table render / detail view ----------

function renderDomainTable() {
  const tbody = document.getElementById('domain-tbody');
  tbody.innerHTML = '';

  state.domains.forEach((dom) => {
    const tr = document.createElement('tr');
    tr.dataset.id = dom.id;
    const expiryClass = getExpiryClass(dom);
    if (expiryClass) {
      tr.classList.add(expiryClass);
    }

    const hostCount = (dom.hosts || []).length;

    const dnsProvider = dom.cache && dom.cache.dns
      ? (dom.cache.dns.dnsProvider || '')
      : '';

    const expiry = (dom.cache && dom.cache.rdap && dom.cache.rdap.expires)
      ? new Date(dom.cache.rdap.expires).toISOString().slice(0, 10)
      : '';

    tr.innerHTML = `
      <td>${escapeHtml(dom.name)}</td>
      <td>${escapeHtml(dnsProvider || '—')}</td>
      <td>${escapeHtml(expiry || '—')}</td>
      <td>${hostCount}</td>
      <td>${escapeHtml(dom.notes || '')}</td>
      <td class="actions-cell">
        <button type="button" class="secondary btn-small edit-btn">Edit</button>
        <button type="button" class="secondary btn-small delete-btn">Delete</button>
      </td>
    `;

    tr.addEventListener('click', () => {
      showDomainDetail(dom.id);
    });

    const editBtn = tr.querySelector('.edit-btn');
    const deleteBtn = tr.querySelector('.delete-btn');

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startEditDomain(dom.id);
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDomain(dom.id);
    });

    tbody.appendChild(tr);
  });
}

function showDomainDetail(id) {
  const dom = state.domains.find(d => d.id === id);
  if (!dom) return;
  currentDetailId = id;

  const detail = document.getElementById('domain-detail');
  document.getElementById('detail-title').textContent = dom.name;
  document.getElementById('detail-notes').textContent = dom.notes || '';

  const lastChecked = dom.cache && dom.cache.lastChecked
    ? `Last checked: ${new Date(dom.cache.lastChecked).toLocaleString()}`
    : 'Never checked';
  document.getElementById('detail-last-checked').textContent = lastChecked;

  // Summary from RDAP cache
  const summaryEl = document.getElementById('detail-summary');
  const rdap = dom.cache && dom.cache.rdap ? dom.cache.rdap : null;
  if (rdap) {
    const expiryText = rdap.expires ? new Date(rdap.expires).toISOString().slice(0, 10) : 'unknown';
    const registrarText = rdap.registrar || 'unknown';
    const statusText = (rdap.status || []).join(', ') || 'none';
    summaryEl.innerHTML = `
      <div>Registrar: <strong>${escapeHtml(registrarText)}</strong></div>
      <div>Expiry: <strong>${escapeHtml(expiryText)}</strong></div>
      <div>Status: ${escapeHtml(statusText)}</div>
    `;
  } else {
    summaryEl.textContent = 'No RDAP data cached yet.';
  }

  // DNS summary (NS, MX, TXT)
  const dnsSummaryEl = document.getElementById('detail-dns-summary');
  const dns = dom.cache && dom.cache.dns ? dom.cache.dns : null;

  if (dns) {
    const nsList = (dns.ns || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
    const mxList = (dns.mx || []).map(r => `<li>${escapeHtml(r.preference + ' ' + r.exchange)}</li>`).join('');
    const txtList = (dns.txt || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');

    const providerText = dns.dnsProvider || 'Unknown';

    dnsSummaryEl.innerHTML = `
      <div class="dns-section">
        <strong>DNS provider</strong>: ${escapeHtml(providerText)}</strong>
      </div>
      <div class="dns-section">
        <strong>NS</strong>
        <ul class="dns-list">${nsList || '<li>None</li>'}</ul>
      </div>
      <div class="dns-section">
        <strong>MX</strong>
        <ul class="dns-list">${mxList || '<li>None</li>'}</ul>
      </div>
      <div class="dns-section">
        <strong>TXT</strong>
        <ul class="dns-list">${txtList || '<li>None (or not fetched)</li>'}</ul>
      </div>
    `;
  } else {
    dnsSummaryEl.textContent = 'No DNS data cached yet.';
  }

  // Hosts
  const hostsContainer = document.getElementById('detail-hosts');
  hostsContainer.innerHTML = '';

  (dom.hosts || []).forEach(host => {
    const hostDiv = document.createElement('div');
    const fqdn = host.name === '@' ? dom.name : `${host.name}.${dom.name}`;
    const hostCache = dns && dns.hosts ? dns.hosts[host.name] : null;

    let recordsHtml = '';
    if (hostCache) {
      const aRecs = (hostCache.a || []).join(', ');
      const aaaaRecs = (hostCache.aaaa || []).join(', ');
      const cnameRec = hostCache.cname || '';
      const hosting = hostCache.hostingProvider || 'Unknown';
      recordsHtml = `
        <div class="small">
          Hosting: <strong>${escapeHtml(hosting)}</strong><br>
          A: ${escapeHtml(aRecs || '—')}<br>
          AAAA: ${escapeHtml(aaaaRecs || '—')}<br>
          CNAME: ${escapeHtml(cnameRec || '—')}
        </div>
      `;
    } else {
      recordsHtml = `<div class="small">No host DNS data cached yet.</div>`;
    }

    hostDiv.style.marginBottom = '0.5rem';
    hostDiv.innerHTML = `
      <div class="pill">${escapeHtml(host.name)}</div>
      <span>${escapeHtml(fqdn)}</span>
      ${recordsHtml}
    `;
    hostsContainer.appendChild(hostDiv);
  });

  detail.classList.add('active');
}

// ---------- Add / edit / delete ----------

function normaliseHosts(hostsList) {
  return (hostsList || '')
    .split(',')
    .map(h => h.trim())
    .filter(h => h.length > 0)
    .map(h => ({ name: h }));
}

function addDomain(name, hostsList, notes) {
  const trimmedName = name.trim();
  if (!trimmedName) return;

  const id = 'dom_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  const hosts = normaliseHosts(hostsList);

  state.domains.push({
    id,
    name: trimmedName,
    notes: (notes || '').trim(),
    hosts,
    cache: {}
  });

  saveState();
  renderDomainTable();
}

function updateDomain(id, name, hostsList, notes) {
  const dom = state.domains.find(d => d.id === id);
  if (!dom) return;

  const trimmedName = name.trim();
  if (!trimmedName) return;

  dom.name = trimmedName;
  dom.notes = (notes || '').trim();
  dom.hosts = normaliseHosts(hostsList);

  // Easiest / safest: clear cache when core domain/hosts change
  dom.cache = {};

  saveState();
  renderDomainTable();

  if (currentDetailId === id) {
    showDomainDetail(id);
  }
}

function deleteDomain(id) {
  const dom = state.domains.find(d => d.id === id);
  if (!dom) return;

  if (!window.confirm(`Delete domain "${dom.name}"? This cannot be undone (except via re-import).`)) {
    return;
  }

  state.domains = state.domains.filter(d => d.id !== id);
  saveState();
  renderDomainTable();

  if (currentDetailId === id) {
    currentDetailId = null;
    document.getElementById('domain-detail').classList.remove('active');
  }

  if (editingId === id) {
    resetFormToAddMode();
  }
}

function startEditDomain(id) {
  const dom = state.domains.find(d => d.id === id);
  if (!dom) return;

  editingId = id;

  document.getElementById('domain-name').value = dom.name;
  document.getElementById('domain-hosts').value = (dom.hosts || []).map(h => h.name).join(', ');
  document.getElementById('domain-notes').value = dom.notes || '';

  document.getElementById('form-title').textContent = 'Edit Domain';
  document.getElementById('domain-submit-btn').textContent = 'Save changes';
  document.getElementById('cancel-edit-btn').style.display = 'inline-block';
}

function resetFormToAddMode() {
  editingId = null;
  document.getElementById('add-domain-form').reset();
  document.getElementById('form-title').textContent = 'Add Domain';
  document.getElementById('domain-submit-btn').textContent = 'Add domain';
  document.getElementById('cancel-edit-btn').style.display = 'none';
}

// ---------- Import / export ----------

function exportJSON() {
  const dataStr = JSON.stringify(state, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'domain-inventory.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus('Exported current data.');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed || !Array.isArray(parsed.domains)) {
        throw new Error('Invalid format: missing domains array');
      }
      state = parsed;
      saveState();
      renderDomainTable();
      document.getElementById('domain-detail').classList.remove('active');
      resetFormToAddMode();
      setStatus('Import successful.');
    } catch (err) {
      console.error(err);
      setStatus('Import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ---------- Sorting ----------

function getDnsProviderForSort(dom) {
  return (dom.cache &&
          dom.cache.dns &&
          dom.cache.dns.dnsProvider
         ) ? dom.cache.dns.dnsProvider.toLowerCase() : '';
}

function getExpiryForSort(dom) {
  const rdap = dom.cache && dom.cache.rdap;
  if (rdap && rdap.expires) {
    return new Date(rdap.expires).getTime();
  }
  return Number.MAX_SAFE_INTEGER; // put "unknown" at the bottom
}

function setupSorting() {
  const headers = document.querySelectorAll('#domain-table th[data-sort]');
  headers.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const asc = th.dataset.asc !== 'true'; // toggle
      th.dataset.asc = asc ? 'true' : 'false';

      state.domains.sort((a, b) => {
        let av, bv;

        if (key === 'hostCount') {
          av = (a.hosts || []).length;
          bv = (b.hosts || []).length;
        } else if (key === 'dnsProvider') {
          av = getDnsProviderForSort(a);
          bv = getDnsProviderForSort(b);
        } else if (key === 'expiry') {
          av = getExpiryForSort(a);
          bv = getExpiryForSort(b);
        } else {
          av = (a[key] || '').toString().toLowerCase();
          bv = (b[key] || '').toString().toLowerCase();
        }

        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
      });

      renderDomainTable();
    });
  });
}

// ---------- DNS & RDAP fetchers ----------

// Google DNS-over-HTTPS: https://dns.google/resolve?name=example.com&type=A
async function dnsQuery(name, type) {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('DNS query failed', name, type, res.status);
      return [];
    }
    const data = await res.json();
    if (data.Status !== 0 || !data.Answer) {
      return [];
    }
    return data.Answer || [];
  } catch (err) {
    console.warn('DNS query error', name, type, err);
    return [];
  }
}

async function fetchNS(domain) {
  const answers = await dnsQuery(domain, 'NS');
  return answers.map(a => a.data.replace(/\.$/, ''));
}

async function fetchTXT(domain) {
  const answers = await dnsQuery(domain, 'TXT');
  return answers.map(a => a.data);
}

async function fetchMX(domain) {
  const answers = await dnsQuery(domain, 'MX');
  return answers.map(a => {
    // "10 mail.example.com."
    const parts = a.data.split(/\s+/);
    const pref = parseInt(parts[0], 10);
    const exch = parts.slice(1).join(' ').replace(/\.$/, '');
    return { preference: pref, exchange: exch };
  });
}

async function fetchHostRecords(fqdn) {
  const [aAns, aaaaAns, cnameAns] = await Promise.all([
    dnsQuery(fqdn, 'A'),
    dnsQuery(fqdn, 'AAAA'),
    dnsQuery(fqdn, 'CNAME')
  ]);

  const ipv4Pattern = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;

  const a = (aAns || [])
    .filter(r => r.type === 1 && ipv4Pattern.test(r.data))
    .map(r => r.data);

  const aaaa = (aaaaAns || [])
    .filter(r => r.type === 28)
    .map(r => r.data);

  const cnameRec = (cnameAns || [])
    .filter(r => r.type === 5)
    .map(r => r.data.replace(/\.$/, ''))[0] || '';

  return { a, aaaa, cname: cnameRec };
}

// RDAP via rdap.org (best-effort; may hit CORS issues)

function rdapUrlForDomain(domain) {
  const lower = domain.toLowerCase();

  if (lower.endsWith('.de')) {
    // DENIC’s RDAP endpoint for .de
    return `https://rdap.denic.de/domain/${encodeURIComponent(domain)}`;
  }

  // default: rdap.org aggregator
  return `https://rdap.org/domain/${encodeURIComponent(domain)}`;
}

async function fetchRDAP(domain) {
  const url = rdapUrlForDomain(domain);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('RDAP query failed', domain, res.status);
      return null;
    }
    const data = await res.json();

    // expiry: look for eventAction 'expiration'
    let expires = null;
    if (Array.isArray(data.events)) {
      const expEvent = data.events.find(e => e.eventAction === 'expiration');
      if (expEvent && expEvent.eventDate) {
        expires = expEvent.eventDate;
      }
    }

    // registrar name: entity with role 'registrar', vcardArray[1] entry "fn"
    let registrar = null;
    if (Array.isArray(data.entities)) {
      for (const ent of data.entities) {
        if (Array.isArray(ent.roles) && ent.roles.includes('registrar') && Array.isArray(ent.vcardArray)) {
          const vcard = ent.vcardArray[1] || [];
          const fn = vcard.find(v => v[0] === 'fn');
          if (fn && fn[3]) {
            registrar = fn[3];
            break;
          }
        }
      }
    }

    const status = Array.isArray(data.status) ? data.status : [];

    return {
      raw: data,
      registrar,
      expires,
      status
    };
  } catch (err) {
    console.warn('RDAP query error', domain, err);
    return null;
  }
}

async function refreshDomainDNSAndRDAP(id) {
  const dom = state.domains.find(d => d.id === id);
  if (!dom) return;

  setStatus(`Refreshing DNS/RDAP for ${dom.name}...`);

  const refreshBtn = document.getElementById('refresh-domain-btn');
  refreshBtn.disabled = true;

  try {
    const baseName = dom.name;

    // Fetch NS, MX, TXT for the domain itself
    const [ns, mx, txt] = await Promise.all([
      fetchNS(baseName),
      fetchMX(baseName),
      fetchTXT(baseName)
    ]);

    // Fetch host records for each declared host
    const hostsCache = {};
    const hosts = dom.hosts || [];
    for (const host of hosts) {
      const fqdn = host.name === '@' ? baseName : `${host.name}.${baseName}`;
      const rec = await fetchHostRecords(fqdn);
      rec.hostingProvider = guessHostingProvider(fqdn, rec);
      hostsCache[host.name] = rec;
    }

    const dnsProvider = guessDnsProvider(ns);

    const dns = {
      ns,
      mx,
      txt,
      hosts: hostsCache,
      dnsProvider
    };

    // RDAP (may fail; handle as optional)
    const rdap = await fetchRDAP(baseName);

    dom.cache = dom.cache || {};
    dom.cache.dns = dns;
    if (rdap) {
      dom.cache.rdap = rdap;
    }
    dom.cache.lastChecked = new Date().toISOString();

    saveState();
    showDomainDetail(dom.id); // re-render
    renderDomainTable();      // update DNS provider / expiry in main table
    setStatus(`Updated DNS/RDAP for ${dom.name}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Error refreshing DNS/RDAP for ${dom.name}. See console.`);
  } finally {
    refreshBtn.disabled = false;
  }
}

// ---------- Initial setup ----------

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  renderDomainTable();
  setupSorting();

  const addForm = document.getElementById('add-domain-form');

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('domain-name').value;
    const hosts = document.getElementById('domain-hosts').value;
    const notes = document.getElementById('domain-notes').value;

    if (editingId) {
      updateDomain(editingId, name, hosts, notes);
    } else {
      addDomain(name, hosts, notes);
    }

    resetFormToAddMode();
  });

  document.getElementById('cancel-edit-btn').addEventListener('click', (e) => {
    e.preventDefault();
    resetFormToAddMode();
  });

  document.getElementById('export-btn').addEventListener('click', exportJSON);

  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      importJSON(file);
      e.target.value = '';
    }
  });

  document.getElementById('refresh-domain-btn').addEventListener('click', () => {
    if (currentDetailId) {
      refreshDomainDNSAndRDAP(currentDetailId);
    }
  });
});

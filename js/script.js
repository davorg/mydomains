const STORAGE_KEY = 'domainInventory.v1';

let state = {
  version: 1,
  domains: []
};

let currentDetailId = null;
let editingId = null;
let searchQuery = '';
let activeKeywordFilter = null;

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

// Normalize keywords: lowercase, trim, remove duplicates
function normalizeKeywords(keywordsStr) {
  if (!keywordsStr || !keywordsStr.trim()) {
    return [];
  }
  return keywordsStr
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 0)
    .filter((k, idx, arr) => arr.indexOf(k) === idx); // remove duplicates
}

// Generate a unique domain ID
function generateDomainId() {
  return 'dom_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
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

function setKeywordFilter(keyword) {
  activeKeywordFilter = keyword;
  updateKeywordFilterUI();
  renderDomainTable();
  
  // Scroll to the table
  document.getElementById('domain-table-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearKeywordFilter() {
  activeKeywordFilter = null;
  updateKeywordFilterUI();
  renderDomainTable();
}

function updateKeywordFilterUI() {
  const container = document.getElementById('keyword-filter-container');
  const pill = document.getElementById('active-keyword-pill');
  
  if (activeKeywordFilter) {
    container.style.display = 'block';
    pill.textContent = activeKeywordFilter;
  } else {
    container.style.display = 'none';
    pill.textContent = '';
  }
}

function getFilteredDomains() {
  let filtered = state.domains;
  
  // Filter by search query
  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    filtered = filtered.filter(dom => 
      dom.name.toLowerCase().includes(query)
    );
  }
  
  // Filter by keyword
  if (activeKeywordFilter) {
    filtered = filtered.filter(dom => 
      (dom.keywords || []).includes(activeKeywordFilter)
    );
  }
  
  return filtered;
}

function renderDomainTable() {
  const tbody = document.getElementById('domain-tbody');
  tbody.innerHTML = '';

  const domainsToShow = getFilteredDomains();
  
  // Update domain count display
  const totalCount = state.domains.length;
  const filteredCount = domainsToShow.length;
  const domainCountEl = document.getElementById('domain-count');
  
  const isFiltered = searchQuery || activeKeywordFilter;
  
  if (isFiltered && filteredCount !== totalCount) {
    domainCountEl.textContent = `Displaying ${filteredCount} (of ${totalCount}) domains`;
  } else {
    domainCountEl.textContent = `Displaying ${totalCount} domain${totalCount === 1 ? '' : 's'}`;
  }

  domainsToShow.forEach((dom) => {
    const tr = document.createElement('tr');
    tr.dataset.id = dom.id;
    const expiryClass = getExpiryClass(dom);
    if (expiryClass) {
      tr.classList.add(expiryClass);
    }

    // Add selected class if this is the current detail view
    if (currentDetailId === dom.id) {
      tr.classList.add('selected');
    }

    const hostCount = (dom.hosts || []).length;

    const dnsProvider = dom.cache && dom.cache.dns
      ? (dom.cache.dns.dnsProvider || '')
      : '';

    const expiry = (dom.cache && dom.cache.rdap && dom.cache.rdap.expires)
      ? new Date(dom.cache.rdap.expires).toISOString().slice(0, 10)
      : '';

    // Build keywords pills HTML
    const keywords = dom.keywords || [];
    const keywordsPillsHtml = keywords.length > 0
      ? keywords.map(kw => 
          `<span class="pill pill-clickable" data-keyword="${escapeHtml(kw)}">${escapeHtml(kw)}</span>`
        ).join('')
      : '—';

    tr.innerHTML = `
      <td>${escapeHtml(dom.name)}</td>
      <td>${escapeHtml(dnsProvider || '—')}</td>
      <td>${escapeHtml(expiry || '—')}</td>
      <td>${hostCount}</td>
      <td class="keywords-cell">${keywordsPillsHtml}</td>
      <td>${escapeHtml(dom.notes || '')}</td>
      <td class="actions-cell">
        <button type="button" class="secondary btn-small refresh-btn">Refresh</button>
        <button type="button" class="secondary btn-small edit-btn">Edit</button>
        <button type="button" class="secondary btn-small delete-btn">Delete</button>
      </td>
    `;

    tr.addEventListener('click', () => {
      showDomainDetail(dom.id);
    });

    const refreshBtn = tr.querySelector('.refresh-btn');
    const editBtn = tr.querySelector('.edit-btn');
    const deleteBtn = tr.querySelector('.delete-btn');
    const keywordPills = tr.querySelectorAll('.pill-clickable');

    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      refreshDomainDNSAndRDAP(dom.id);
    });

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startEditDomain(dom.id);
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDomain(dom.id);
    });

    keywordPills.forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const keyword = pill.dataset.keyword;
        setKeywordFilter(keyword);
      });
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
  renderDomainTable(); // Re-render to update selected row styling
  
  // Scroll to the detail section
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Add / edit / delete ----------

function normaliseHosts(hostsList) {
  return (hostsList || '')
    .split(',')
    .map(h => h.trim())
    .filter(h => h.length > 0)
    .map(h => ({ name: h }));
}

function addDomain(name, hostsList, notes, keywordsStr) {
  const trimmedName = name.trim();
  if (!trimmedName) return;

  const id = generateDomainId();

  const hosts = normaliseHosts(hostsList);
  const keywords = normalizeKeywords(keywordsStr);

  state.domains.push({
    id,
    name: trimmedName,
    notes: (notes || '').trim(),
    hosts,
    keywords,
    cache: {}
  });

  saveState();
  renderDomainTable();
}

function updateDomain(id, name, hostsList, notes, keywordsStr) {
  const dom = state.domains.find(d => d.id === id);
  if (!dom) return;

  const trimmedName = name.trim();
  if (!trimmedName) return;

  const newHosts = normaliseHosts(hostsList);
  
  // Only clear cache if domain name or hosts changed (not for keywords/notes)
  const nameChanged = dom.name !== trimmedName;
  const hostsChanged = JSON.stringify(dom.hosts) !== JSON.stringify(newHosts);
  
  dom.name = trimmedName;
  dom.notes = (notes || '').trim();
  dom.hosts = newHosts;
  dom.keywords = normalizeKeywords(keywordsStr);

  if (nameChanged || hostsChanged) {
    dom.cache = {};
  }

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
  document.getElementById('domain-keywords').value = (dom.keywords || []).join(', ');

  document.getElementById('form-title').textContent = 'Edit Domain';
  document.getElementById('domain-submit-btn').textContent = 'Update Domain';
  openModal();
}

function resetFormToAddMode() {
  editingId = null;
  document.getElementById('add-domain-form').reset();
  document.getElementById('form-title').textContent = 'Add Domain';
  document.getElementById('domain-submit-btn').textContent = 'Add Domain';
}

function openModal() {
  document.getElementById('domain-modal').classList.add('active');
}

function closeModal() {
  document.getElementById('domain-modal').classList.remove('active');
  resetFormToAddMode();
}

function openImportExportModal() {
  document.getElementById('import-export-modal').classList.add('active');
}

function closeImportExportModal() {
  document.getElementById('import-export-modal').classList.remove('active');
}

function openOnboardingModal() {
  document.getElementById('onboarding-modal').classList.add('active');
}

function closeOnboardingModal() {
  document.getElementById('onboarding-modal').classList.remove('active');
}

// Helper function for closing modals when clicking outside
function setupModalClickOutside(modalId, closeFn) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target.id === modalId) {
        closeFn();
      }
    });
  }
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
      
      // Normalize imported domains to ensure they have required properties
      parsed.domains = parsed.domains.map((dom, index) => {
        if (!dom.name) {
          throw new Error(`Domain at index ${index} is missing required 'name' field`);
        }
        
        return {
          id: dom.id || generateDomainId(),
          name: dom.name,
          hosts: dom.hosts || [],
          notes: dom.notes || '',
          keywords: dom.keywords || [],
          cache: dom.cache || {}
        };
      });
      
      state = parsed;
      saveState();
      renderDomainTable();
      document.getElementById('domain-detail').classList.remove('active');
      resetFormToAddMode();
      closeImportExportModal();
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
      
      // Clear other headers' sort indicators
      headers.forEach(h => {
        if (h !== th) {
          h.removeAttribute('data-asc');
        }
      });
      
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
  if (refreshBtn) {
    refreshBtn.disabled = true;
  }

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
    
    // Only show detail view if this domain is currently selected
    if (currentDetailId === dom.id) {
      showDomainDetail(dom.id); // re-render
    }
    
    renderDomainTable();      // update DNS provider / expiry in main table
    setStatus(`Updated DNS/RDAP for ${dom.name}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Error refreshing DNS/RDAP for ${dom.name}. See console.`);
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
    }
  }
}

// Refresh all domains with progress indication
let isRefreshingAll = false;

async function refreshAllDomains() {
  if (isRefreshingAll) {
    return;
  }

  if (state.domains.length === 0) {
    setStatus('No domains to refresh.');
    return;
  }

  isRefreshingAll = true;
  
  const refreshAllBtn = document.getElementById('refresh-all-btn');
  const progressContainer = document.getElementById('refresh-all-progress');
  const progressText = progressContainer.querySelector('.progress-text');
  const progressBar = progressContainer.querySelector('.progress-bar');
  
  // Show progress UI
  refreshAllBtn.disabled = true;
  progressContainer.style.display = 'block';
  
  const total = state.domains.length;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  
  for (const dom of state.domains) {
    progressText.textContent = `Refreshing ${completed + 1} of ${total}: ${dom.name}`;
    progressBar.style.width = `${(completed / total) * 100}%`;
    
    try {
      await refreshDomainDNSAndRDAPInternal(dom.id);
      succeeded++;
    } catch (err) {
      console.error(`Failed to refresh ${dom.name}:`, err);
      failed++;
    }
    
    completed++;
    progressBar.style.width = `${(completed / total) * 100}%`;
  }
  
  // Show completion message
  progressText.textContent = `Completed: ${succeeded} succeeded, ${failed} failed out of ${total} domains.`;
  progressBar.style.width = '100%';
  
  setStatus(`Refresh all completed: ${succeeded} succeeded, ${failed} failed.`);
  
  // Hide progress UI after a delay
  setTimeout(() => {
    progressContainer.style.display = 'none';
    refreshAllBtn.disabled = false;
    isRefreshingAll = false;
  }, 3000);
}

// Internal refresh function without UI side effects
async function refreshDomainDNSAndRDAPInternal(id) {
  const dom = state.domains.find(d => d.id === id);
  if (!dom) return;

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
  
  // Only show detail view if this domain is currently selected
  if (currentDetailId === dom.id) {
    showDomainDetail(dom.id); // re-render
  }
  
  renderDomainTable();      // update DNS provider / expiry in main table
}

// ---------- Initial setup ----------

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  renderDomainTable();
  setupSorting();

  // Show onboarding modal if there are no domains
  if (state.domains.length === 0) {
    openOnboardingModal();
  }

  const addForm = document.getElementById('add-domain-form');

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('domain-name').value;
    const hosts = document.getElementById('domain-hosts').value;
    const notes = document.getElementById('domain-notes').value;
    const keywords = document.getElementById('domain-keywords').value;

    if (editingId) {
      updateDomain(editingId, name, hosts, notes, keywords);
    } else {
      addDomain(name, hosts, notes, keywords);
    }

    closeModal();
  });

  document.getElementById('cancel-edit-btn').addEventListener('click', (e) => {
    e.preventDefault();
    closeModal();
  });

  document.getElementById('add-domain-btn').addEventListener('click', () => {
    openModal();
  });

  // Setup click-outside-to-close for modals
  setupModalClickOutside('domain-modal', closeModal);
  setupModalClickOutside('import-export-modal', closeImportExportModal);
  setupModalClickOutside('onboarding-modal', closeOnboardingModal);

  // Onboarding modal buttons
  document.getElementById('onboarding-add-btn').addEventListener('click', () => {
    closeOnboardingModal();
    openModal();
  });

  document.getElementById('onboarding-import-btn').addEventListener('click', () => {
    closeOnboardingModal();
    openImportExportModal();
  });

  document.getElementById('onboarding-cancel-btn').addEventListener('click', closeOnboardingModal);

  document.getElementById('import-export-btn').addEventListener('click', openImportExportModal);

  document.getElementById('cancel-import-export-btn').addEventListener('click', closeImportExportModal);

  const importBtn = document.getElementById('import-btn');
  const importFile = document.getElementById('import-file');
  
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => {
      importFile.click();
    });
    
    importFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        importJSON(file);
        e.target.value = '';
      }
    });
  }

  document.getElementById('export-btn').addEventListener('click', exportJSON);

  document.getElementById('refresh-domain-btn').addEventListener('click', () => {
    if (currentDetailId) {
      refreshDomainDNSAndRDAP(currentDetailId);
    }
  });

  // Search functionality
  const searchInput = document.getElementById('domain-search');
  const clearSearchBtn = document.getElementById('clear-search');

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderDomainTable();
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    renderDomainTable();
  });

  // Keyword filter functionality
  const clearKeywordFilterBtn = document.getElementById('clear-keyword-filter');
  
  clearKeywordFilterBtn.addEventListener('click', () => {
    clearKeywordFilter();
  });

  // Refresh all functionality
  const refreshAllBtn = document.getElementById('refresh-all-btn');
  
  refreshAllBtn.addEventListener('click', () => {
    refreshAllDomains();
  });
});

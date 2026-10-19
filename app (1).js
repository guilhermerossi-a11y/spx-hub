const CHANNEL = 'spx-extension-loader';
const PROFILE = 'spx';
const PAGE_SIZE = 10;
const REFRESH_MS = 60 * 1000;
const FETCH_PAGE_COUNT = 100;
const MAX_PAGES = 10;

// Ajuste aqui se os nomes dos campos da API do SPX forem diferentes.
const FIELDS = {
  lh:      ['lh_trip_number', 'trip_number', 'linehaul_trip_number', 'lh_number', 'trip_no'],
  driver:  ['driver_name', 'driver', 'driver_info', 'driver_full_name'],
  plate:   ['vehicle_number', 'vehicle_plate', 'license_plate', 'plate_number', 'vehicle_no'],
  pkgs:    ['parcel_count', 'total_parcel', 'parcel_quantity', 'order_count', 'total_orders', 'parcel_qty'],
  tos:     ['to_count', 'total_to', 'to_quantity', 'to_qty', 'to_number'],
  origin:  ['previous_station_name', 'origin_station_name', 'from_station_name', 'previous_station', 'origin'],
  status:  ['trip_status_name', 'status_name', 'trip_status', 'status'],
  vehicle: ['vehicle_type_name', 'vehicle_type', 'vehicle_type_desc'],
  date:    ['sta', 'std', 'eta', 'etd', 'ata']
};

// Status do SPX -> status operacional do painel.
const SPX_TO_OP = { unloaded: 'Finalizado', unsealed: 'Descarregando', unseal: 'Descarregando', arrived: 'Aguardando', pending: 'A caminho' };
const OP_STATUS = ['A caminho', 'Aguardando', 'Doca', 'Descarregando', 'Finalizado'];

const DEFAULT_CONFIG = { url: '', method: 'POST', body: '{\n  "pageno": {pageno},\n  "count": {count}\n}', vehicle: 'CARRETA' };

const $ = id => document.getElementById(id);
let config = { ...DEFAULT_CONFIG };
let opState = {};
let rowsAll = [];
let page = 1;
let timer = null;
let lastRaw = null;
const pending = new Map();

window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || m.channel !== CHANNEL || m.type !== 'BRIDGE_RESPONSE') return;
  const resolve = pending.get(m.requestId);
  if (resolve) { pending.delete(m.requestId); resolve(m.response); }
});

function bridge(operation, payload) {
  return new Promise(resolve => {
    const requestId = crypto.randomUUID();
    const t = setTimeout(() => { pending.delete(requestId); resolve({ ok: false, error: 'Tempo esgotado ao falar com o loader. Abra este painel pelo SPX Extension Loader.' }); }, 30000);
    pending.set(requestId, r => { clearTimeout(t); resolve(r); });
    window.parent.postMessage({ channel: CHANNEL, type: 'BRIDGE_REQUEST', requestId, moduleId: 'painel-carretas', operation, payload }, '*');
  });
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pick = (obj, keys) => { for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]; return ''; };

function findList(node, depth = 0) {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== 'object' || depth > 3) return null;
  for (const v of Object.values(node)) { const f = findList(v, depth + 1); if (f?.length !== undefined && Array.isArray(f)) return f; }
  return null;
}

function fillTemplate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

function toDate(v) {
  if (!v) return null;
  const n = Number(v);
  const d = Number.isFinite(n) && n > 1e8 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
  return isNaN(d) ? null : d;
}

function normalize(item) {
  const spx = String(pick(item, FIELDS.status));
  const d = toDate(pick(item, FIELDS.date));
  return {
    lh: String(pick(item, FIELDS.lh)),
    driver: String(pick(item, FIELDS.driver)),
    plate: String(pick(item, FIELDS.plate)),
    pkgs: Number(pick(item, FIELDS.pkgs)) || 0,
    tos: pick(item, FIELDS.tos),
    origin: String(pick(item, FIELDS.origin)),
    vehicle: String(pick(item, FIELDS.vehicle)),
    spxStatus: spx,
    date: d ? d.toISOString().slice(0, 10) : '',
    op: opState[String(pick(item, FIELDS.lh))] || SPX_TO_OP[spx.toLowerCase()] || 'Aguardando'
  };
}

async function loadConfig() {
  const r = await bridge('storage.get', { keys: ['config', 'opState'] });
  if (r.ok) {
    config = { ...DEFAULT_CONFIG, ...(r.values.config || {}) };
    opState = r.values.opState || {};
  }
}

async function fetchTrips() {
  if (!config.url) throw new Error('Configure a URL da API do SPX (botão Configurar).');
  const all = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const now = Date.now();
    const vars = { pageno: p, count: FETCH_PAGE_COUNT, from: Math.floor((now - 2 * 864e5) / 1000), to: Math.floor((now + 864e5) / 1000) };
    const request = { key: 'trips', url: fillTemplate(config.url, vars), method: config.method };
    if (config.method !== 'GET') {
      try { request.body = JSON.parse(fillTemplate(config.body || '{}', vars)); }
      catch { throw new Error('O Body JSON da configuração é inválido.'); }
    }
    const res = await bridge('network.fetchBatch', { profileId: PROFILE, requests: [request] });
    if (!res.ok && !res.results) throw new Error(res.error || 'Falha ao consultar o SPX.');
    const item = res.results?.trips;
    if (!item?.ok) throw new Error(item?.error || res.error || 'Falha ao consultar o SPX.');
    lastRaw = item.data;
    const list = findList(item.data?.data ?? item.data) || [];
    all.push(...list);
    if (list.length < FETCH_PAGE_COUNT) break;
  }
  return all;
}

async function refresh() {
  $('btnRefresh').disabled = true;
  try {
    const list = await fetchTrips();
    const needle = (config.vehicle || '').toLowerCase();
    rowsAll = list.map(normalize).filter(r => !needle || !r.vehicle || r.vehicle.toLowerCase().includes(needle));
    $('error').classList.add('hidden');
    $('updated').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
    rebuildStatusFilter();
    render();
  } catch (e) {
    $('error').textContent = e.message;
    $('error').classList.remove('hidden');
  } finally {
    $('btnRefresh').disabled = false;
  }
}

function rebuildStatusFilter() {
  const sel = $('fStatus'), cur = sel.value;
  sel.innerHTML = '<option value="">Todos</option>' + OP_STATUS.map(s => `<option>${s}</option>`).join('');
  sel.value = cur;
}

function filtered() {
  const st = $('fStatus').value, date = $('fDate').value;
  const org = $('fOrigin').value.trim().toLowerCase(), q = $('fSearch').value.trim().toLowerCase();
  return rowsAll.filter(r =>
    (!st || r.op === st) && (!date || !r.date || r.date === date) &&
    (!org || r.origin.toLowerCase().includes(org)) &&
    (!q || [r.lh, r.driver, r.plate].some(v => v.toLowerCase().includes(q))));
}

function render() {
  const rows = filtered();
  $('kTotal').textContent = rows.length;
  $('kPkgs').textContent = rows.reduce((s, r) => s + r.pkgs, 0).toLocaleString('pt-BR');
  $('kDone').textContent = rows.filter(r => r.op === 'Finalizado').length;
  $('kQueue').textContent = rows.filter(r => r.op === 'Aguardando').length;

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  page = Math.min(page, pages);
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  $('rows').innerHTML = slice.length ? slice.map(r => `
    <tr>
      <td>${esc(r.lh)}</td><td>${esc(r.driver)}</td><td>${esc(r.plate)}</td>
      <td>${r.pkgs.toLocaleString('pt-BR')}</td><td>${esc(r.tos)}</td><td>${esc(r.origin)}</td>
      <td><select class="st-${r.op.toLowerCase().replace(/\s/g, '')}" data-lh="${esc(r.lh)}">
        ${OP_STATUS.map(s => `<option${s === r.op ? ' selected' : ''}>${s}</option>`).join('')}
      </select></td>
    </tr>`).join('') : '<tr><td class="empty" colspan="7">Nenhuma carreta encontrada.</td></tr>';

  $('pageInfo').textContent = `Página ${page} de ${pages}`;
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;
}

async function checkConnection() {
  const r = await bridge('network.connectionStatus', { profileId: PROFILE });
  const el = $('conn');
  if (r.ok && (r.hasTab || r.hasCapturedHeaders)) { el.textContent = r.hasTab ? 'SPX conectado' : 'Sessão capturada'; el.className = 'conn ok'; }
  else { el.textContent = 'Abra o SPX em outra aba'; el.className = 'conn bad'; }
}

function tickClock() { $('clock').textContent = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }

// Eventos
$('rows').addEventListener('change', async e => {
  const sel = e.target.closest('select[data-lh]');
  if (!sel) return;
  opState[sel.dataset.lh] = sel.value;
  await bridge('storage.set', { items: { opState } });
  const r = rowsAll.find(x => x.lh === sel.dataset.lh);
  if (r) r.op = sel.value;
  render();
});
['fStatus', 'fDate', 'fOrigin', 'fSearch'].forEach(id => $(id).addEventListener('input', () => { page = 1; render(); }));
$('prev').onclick = () => { page--; render(); };
$('next').onclick = () => { page++; render(); };
$('btnRefresh').onclick = () => { checkConnection(); refresh(); };

$('btnConfig').onclick = () => {
  $('cUrl').value = config.url; $('cMethod').value = config.method;
  $('cBody').value = config.body; $('cVehicle').value = config.vehicle;
  $('raw').classList.add('hidden');
  $('dlg').showModal();
};
$('cCancel').onclick = () => $('dlg').close();
$('cRaw').onclick = () => {
  const pre = $('raw');
  const sample = findList(lastRaw?.data ?? lastRaw)?.[0];
  pre.textContent = lastRaw ? JSON.stringify(sample ?? lastRaw, null, 2) : 'Ainda sem resposta. Salve a configuração e clique em Atualizar.';
  pre.classList.remove('hidden');
};
$('cfgForm').addEventListener('submit', async () => {
  config = { url: $('cUrl').value.trim(), method: $('cMethod').value, body: $('cBody').value, vehicle: $('cVehicle').value.trim() };
  await bridge('storage.set', { items: { config } });
  refresh();
});

(async function init() {
  tickClock(); setInterval(tickClock, 30000);
  $('fDate').value = new Date().toLocaleDateString('sv-SE');
  await loadConfig();
  checkConnection();
  if (!config.url) { $('btnConfig').click(); } else { refresh(); }
  timer = setInterval(() => { checkConnection(); if (config.url) refresh(); }, REFRESH_MS);
})();

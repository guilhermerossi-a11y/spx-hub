const CHANNEL = 'spx-extension-loader';
const pending = new Map();
let modules = [];

window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || m.channel !== CHANNEL || m.type !== 'BRIDGE_RESPONSE') return;
  const resolve = pending.get(m.requestId);
  if (resolve) { pending.delete(m.requestId); resolve(m.response); }
});

function bridge(operation, payload) {
  return new Promise(resolve => {
    const requestId = crypto.randomUUID();
    const t = setTimeout(() => { pending.delete(requestId); resolve({ ok: false, error: 'Sem resposta do loader. Abra esta página pelo ícone da extensão.' }); }, 15000);
    pending.set(requestId, r => { clearTimeout(t); resolve(r); });
    window.parent.postMessage({ channel: CHANNEL, type: 'BRIDGE_REQUEST', requestId, moduleId: 'launcher', operation, payload }, '*');
  });
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const list = modules.filter(m => m.enabled && (!q || `${m.name} ${m.description}`.toLowerCase().includes(q)));
  document.getElementById('msg').textContent = list.length ? '' : 'Nenhuma ferramenta encontrada.';
  document.getElementById('grid').innerHTML = list.map(m => `
    <button class="tool" type="button" data-id="${esc(m.id)}">
      <b>${esc(m.name)}</b><span>${esc(m.description)}</span><small>v${esc(m.version)}</small>
    </button>`).join('');
}

document.getElementById('grid').addEventListener('click', e => {
  const btn = e.target.closest('.tool');
  if (btn) window.parent.postMessage({ channel: CHANNEL, type: 'OPEN_MODULE', moduleId: btn.dataset.id }, '*');
});
document.getElementById('search').addEventListener('input', render);

(async () => {
  const r = await bridge('catalog.get');
  if (!r.ok) { document.getElementById('msg').textContent = r.error || 'Falha ao carregar o catálogo.'; return; }
  modules = r.catalog.modules;
  document.getElementById('hubName').textContent = r.catalog.name || 'SPX Hub';
  render();
})();

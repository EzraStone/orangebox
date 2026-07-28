// §11 — placeholder shell for M0. Proves the static route, the API, and the
// no-innerHTML rule; the runs/timeline/detail UI arrives in M3.
const app = document.getElementById('app');

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const origin = location.origin;

const status = el('div', { class: 'status' }, 'checking…');

app.append(
  el('div', { class: 'boot' }, [
    el('h1', {}, '▮ orangebox'),
    el('p', {}, 'Recording. Point your agent at this address and its calls land here.'),
    el('div', { class: 'card' }, [
      el(
        'pre',
        {},
        `export ANTHROPIC_BASE_URL="${origin}/anthropic"\nexport OPENAI_BASE_URL="${origin}/openai"`
      )
    ]),
    status
  ])
);

async function poll() {
  try {
    const res = await fetch('/api/health');
    const health = await res.json();
    status.replaceChildren(
      el('span', { class: 'dot' }, '●'),
      ` v${health.version} · ${health.runs} run${health.runs === 1 ? '' : 's'} · ${health.db}`
    );
  } catch {
    status.replaceChildren(el('span', { class: 'dot down' }, '●'), ' offline');
  }
}

poll();
setInterval(poll, 5000);

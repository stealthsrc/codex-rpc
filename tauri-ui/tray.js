const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const { LogicalSize } = window.__TAURI__.dpi;

const rows = {
  primary: document.querySelector('[data-usage="primary"]'),
  secondary: document.querySelector('[data-usage="secondary"]'),
  spark_primary: document.querySelector('[data-usage="spark_primary"]'),
  spark_secondary: document.querySelector('[data-usage="spark_secondary"]'),
};

function applyTheme() {
  const stored = localStorage.getItem('codex-rpc-theme') || 'dark';
  const resolved =
    stored === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : stored;
  document.body.dataset.theme = resolved;
}

function setUsageRow(row, value) {
  const fill = row.querySelector('.usage-fill');
  const label = row.querySelector('.usage-value');
  if (!value) {
    label.textContent = '—';
    fill.style.width = '0';
    fill.className = 'usage-fill';
    return;
  }
  label.textContent = value;
  const percent = Number.parseFloat(value);
  if (Number.isFinite(percent)) {
    const clamped = Math.max(0, Math.min(100, percent));
    fill.style.width = `${clamped}%`;
    fill.className = 'usage-fill';
    if (clamped <= 10) fill.classList.add('critical');
    else if (clamped <= 25) fill.classList.add('low');
  } else {
    fill.style.width = '0';
    fill.className = 'usage-fill';
  }
}

function render(snapshot) {
  const dot = document.querySelector('#status-dot');
  dot.className = 'status-dot';
  if (/CLI|Desktop/.test(snapshot.state)) dot.classList.add('active');
  else if (/Monitoring/.test(snapshot.state)) dot.classList.add('monitor');
  dot.title = snapshot.state;

  const model = document.querySelector('#model-line');
  model.textContent = snapshot.model || snapshot.state;

  setUsageRow(rows.primary, snapshot.usage.primary);
  setUsageRow(rows.secondary, snapshot.usage.secondary);
  setUsageRow(rows.spark_primary, snapshot.usage.spark_primary);
  setUsageRow(rows.spark_secondary, snapshot.usage.spark_secondary);

  document.querySelector('#startup-label').textContent = snapshot.startup_label;
  document.querySelector('#startup-switch').classList.toggle('on', snapshot.startup_enabled);
  document.querySelector('#discord-line').textContent = snapshot.discord || 'Discord: —';
}

async function refresh() {
  try {
    applyTheme();
    render(await invoke('tray_snapshot'));
  } catch {
    // Status file may not exist yet; keep placeholders.
  }
}

async function fitWindow() {
  const card = document.querySelector('#card');
  const height = card.offsetHeight + 20;
  await appWindow.setSize(new LogicalSize(300, height));
}

document.querySelector('#item-settings').addEventListener('click', async () => {
  await invoke('open_settings_from_tray');
});

document.querySelector('#item-startup').addEventListener('click', async () => {
  const enabled = await invoke('toggle_startup');
  document.querySelector('#startup-switch').classList.toggle('on', enabled);
});

document.querySelector('#item-quit').addEventListener('click', async () => {
  await invoke('quit_app');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') appWindow.hide();
});

window.addEventListener('contextmenu', (event) => event.preventDefault());

listen('tray:refresh', refresh);

(async () => {
  applyTheme();
  await refresh();
  await fitWindow();
  setInterval(refresh, 2000);
})();

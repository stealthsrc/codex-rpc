const invoke = window.__TAURI__.core.invoke;

const presets = {
  codex: ['Open Codex', 'https://chatgpt.com/codex'],
  usage: ['Usage', 'https://chatgpt.com/codex/settings/analytics'],
  repo: ['GitHub repo', 'https://github.com/StealthyLabsHQ/codex-rpc'],
};

const fields = {
  mode: document.querySelector('#mode'),
  labels: [document.querySelector('#label0'), document.querySelector('#label1')],
  urls: [document.querySelector('#url0'), document.querySelector('#url1')],
  status: document.querySelector('#status'),
  message: document.querySelector('#message'),
  themeButtons: [...document.querySelectorAll('[data-theme-option]')],
};

function readForm() {
  const buttons = [];
  for (let i = 0; i < 2; i += 1) {
    const label = fields.labels[i].value.trim();
    const url = fields.urls[i].value.trim();
    if (label && url) buttons.push({ label, url });
  }
  return { mode: fields.mode.value, buttons };
}

function writeForm(settings) {
  fields.mode.value = settings.mode || 'playing';
  for (let i = 0; i < 2; i += 1) {
    fields.labels[i].value = settings.buttons?.[i]?.label || '';
    fields.urls[i].value = settings.buttons?.[i]?.url || '';
  }
  syncButtons();
}

function syncButtons() {
  const enabled = fields.mode.value === 'watching';
  for (const input of [...fields.labels, ...fields.urls]) input.disabled = !enabled;
  document.querySelectorAll('.presets button, #clear').forEach((button) => {
    button.disabled = !enabled;
  });
}

async function load() {
  try {
    applyTheme(localStorage.getItem('codex-rpc-theme') || 'dark');
    await invoke('start_daemon');
    writeForm(await invoke('load_settings'));
    const status = await invoke('load_status');
    fields.status.textContent = formatStatus(status.status_line);
  } catch (error) {
    fields.message.textContent = String(error);
  }
}

function formatStatus(value) {
  return (value || 'Codex: Off').split('|').filter(Boolean).join(' | ');
}

async function save() {
  try {
    await invoke('save_settings', { settings: readForm() });
    fields.message.textContent = 'applied';
  } catch (error) {
    fields.message.textContent = String(error);
  }
}

document.querySelector('#apply').addEventListener('click', () => save());
document.querySelector('#close').addEventListener('click', () => invoke('close_settings'));
fields.themeButtons.forEach((button) => {
  button.addEventListener('click', () => applyTheme(button.dataset.themeOption));
});
document.querySelector('#clear').addEventListener('click', () => {
  for (const input of [...fields.labels, ...fields.urls]) input.value = '';
});
fields.mode.addEventListener('change', syncButtons);

document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const [label, url] = presets[button.dataset.preset];
    const slot = fields.labels[0].value.trim() ? 1 : 0;
    fields.labels[slot].value = label;
    fields.urls[slot].value = url;
  });
});

window.addEventListener('DOMContentLoaded', load);
setInterval(async () => {
  try {
    fields.status.textContent = formatStatus((await invoke('load_status')).status_line);
  } catch {
    fields.status.textContent = 'Codex: Off';
  }
}, 3000);

function applyTheme(theme) {
  const safeTheme = ['dark', 'system', 'light'].includes(theme) ? theme : 'dark';
  const resolved =
    safeTheme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : safeTheme;
  document.body.dataset.theme = resolved;
  fields.themeButtons.forEach((button) => {
    const active = button.dataset.themeOption === safeTheme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  localStorage.setItem('codex-rpc-theme', safeTheme);
}

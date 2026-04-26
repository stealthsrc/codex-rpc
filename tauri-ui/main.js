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
  usage5hToggle: document.querySelector('#usage-5h-toggle'),
  usageWeekToggle: document.querySelector('#usage-week-toggle'),
  status: document.querySelector('#status'),
  message: document.querySelector('#message'),
  previewActivity: document.querySelector('#preview-activity'),
  previewDetails: document.querySelector('#preview-details'),
  previewState: document.querySelector('#preview-state'),
  previewButtons: document.querySelector('#preview-buttons'),
  themeButtons: [...document.querySelectorAll('[data-theme-option]')],
};

let loading = true;
let saveTimer = null;
let lastStatusLine = 'Codex: Off';

function readForm() {
  const buttons = [];
  for (let i = 0; i < 2; i += 1) {
    const label = fields.labels[i].value.trim();
    const url = fields.urls[i].value.trim();
    if (label && url) buttons.push({ label, url });
  }
  return {
    mode: fields.mode.value,
    buttons,
    show_primary_usage: fields.usage5hToggle.dataset.enabled === 'true',
    show_weekly_usage: fields.usageWeekToggle.dataset.enabled === 'true',
  };
}

function writeForm(settings) {
  fields.mode.value = settings.mode || 'playing';
  const legacyHidden = settings.show_usage === false;
  syncUsageToggle(fields.usage5hToggle, !legacyHidden && settings.show_primary_usage !== false, '5h');
  syncUsageToggle(fields.usageWeekToggle, !legacyHidden && settings.show_weekly_usage !== false, 'Week');
  for (let i = 0; i < 2; i += 1) {
    fields.labels[i].value = settings.buttons?.[i]?.label || '';
    fields.urls[i].value = settings.buttons?.[i]?.url || '';
  }
  syncButtons();
  updatePreview();
}

function syncUsageToggle(button, enabled, label) {
  button.dataset.enabled = String(enabled);
  button.textContent = `${label} ${enabled ? 'on' : 'off'}`;
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
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
    setStatus(status.status_line);
    loading = false;
  } catch (error) {
    fields.message.textContent = String(error);
    loading = false;
  }
}

function formatStatus(value) {
  return (value || 'Codex: Off').split('|').filter(Boolean).join(' | ');
}

function parseStatus(value) {
  const [codex = 'Codex: Off', model = '', usage = '', discord = ''] = (value || 'Codex: Off')
    .split('|')
    .map((part) => part.trim());
  return { codex, model, usage, discord };
}

function updatePreview() {
  const status = parseStatus(lastStatusLine);
  const settings = readForm();
  const mode = settings.mode || 'playing';
  const activity = {
    watching: 'Watching Codex',
    listening: 'Listening Codex',
    competing: 'Competing Codex',
    playing: 'Playing Codex',
  }[mode] || 'Playing Codex';
  const usageParts = previewUsageParts(status.usage, settings);
  const stateParts = [status.model, ...usageParts].filter(Boolean);

  fields.previewActivity.textContent = activity;
  fields.previewDetails.textContent = previewDetails(status.codex, mode);
  fields.previewState.textContent = truncateText(stateParts.join(' - ') || status.codex, 64);
  renderPreviewButtons(mode, settings.buttons);
}

function renderPreviewButtons(mode, buttons) {
  fields.previewButtons.replaceChildren();
  fields.previewButtons.hidden = mode !== 'watching' || buttons.length === 0;
  if (fields.previewButtons.hidden) return;
  for (const button of buttons.slice(0, 2)) {
    const item = document.createElement('span');
    item.textContent = button.label;
    fields.previewButtons.appendChild(item);
  }
}

function previewDetails(codex, mode) {
  const isWatching = mode === 'watching';
  if (codex.includes('CLI/Desktop')) {
    return isWatching ? 'Watching Codex (CLI + Desktop)' : 'Coding with Codex (CLI + Desktop)';
  }
  if (codex.includes('Desktop')) {
    return isWatching ? 'Watching Codex' : 'Using Codex';
  }
  if (codex.includes('CLI')) {
    return isWatching ? 'Watching Codex CLI' : 'Coding with Codex CLI';
  }
  return 'No Codex activity';
}

function previewUsageParts(usage, settings) {
  return usage
    .replace(/^Usage:\s*/i, '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      if (part.toLowerCase().startsWith('5h')) return settings.show_primary_usage;
      if (part.toLowerCase().startsWith('week')) return settings.show_weekly_usage;
      return true;
    })
    .map((part) => part.replace(/\s+left$/i, ''));
}

function truncateText(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function setStatus(value) {
  lastStatusLine = value || 'Codex: Off';
  fields.status.textContent = formatStatus(lastStatusLine);
  updatePreview();
}

async function save(kind = 'manual') {
  try {
    await invoke('save_settings', { settings: readForm() });
    fields.message.textContent = kind === 'auto' ? 'saved' : 'applied';
    updatePreview();
  } catch (error) {
    fields.message.textContent = String(error);
  }
}

function scheduleSave() {
  if (loading) return;
  clearTimeout(saveTimer);
  fields.message.textContent = 'saving...';
  updatePreview();
  saveTimer = setTimeout(() => save('auto'), 300);
}

document.querySelector('#apply').addEventListener('click', () => save());
document.querySelector('#close').addEventListener('click', () => invoke('close_settings'));
fields.themeButtons.forEach((button) => {
  button.addEventListener('click', () => applyTheme(button.dataset.themeOption));
});
document.querySelector('#clear').addEventListener('click', () => {
  for (const input of [...fields.labels, ...fields.urls]) input.value = '';
  scheduleSave();
});
fields.mode.addEventListener('change', () => {
  syncButtons();
  scheduleSave();
});
fields.usage5hToggle.addEventListener('click', () => {
  syncUsageToggle(fields.usage5hToggle, fields.usage5hToggle.dataset.enabled !== 'true', '5h');
  scheduleSave();
});
fields.usageWeekToggle.addEventListener('click', () => {
  syncUsageToggle(fields.usageWeekToggle, fields.usageWeekToggle.dataset.enabled !== 'true', 'Week');
  scheduleSave();
});
for (const input of [...fields.labels, ...fields.urls]) input.addEventListener('input', scheduleSave);

document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const [label, url] = presets[button.dataset.preset];
    const slot = fields.labels[0].value.trim() ? 1 : 0;
    fields.labels[slot].value = label;
    fields.urls[slot].value = url;
    scheduleSave();
  });
});

window.addEventListener('DOMContentLoaded', load);
setInterval(async () => {
  try {
    setStatus((await invoke('load_status')).status_line);
  } catch {
    setStatus('Codex: Off');
  }
}, 1000);

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

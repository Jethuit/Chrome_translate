const DEFAULT_SETTINGS = {
  llmProfiles: [],
  activeProfileIndex: -1,
  baseUrl: '',
  apiKey: '',
  modelId: '',
  autoJapanese: true,
  autoEnglish: false,
  autoAll: false,
  hotkey: 'Alt',
  targetLang: '中文',
  enabled: true,
  autoTranslateLimit: 3
};

const SUPPORTED_TAB_URLS = [
  'https://twitter.com/*',
  'https://x.com/*',
  'https://mobile.twitter.com/*',
  'https://discord.com/*',
  'https://canary.discord.com/*',
  'https://ptb.discord.com/*'
];

function $(id) {
  return document.getElementById(id);
}

let currentProfiles = [];
let currentProfileIndex = -1;
let saveTimer = null;

async function loadSettings() {
  const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  currentProfiles = result.llmProfiles || [];
  currentProfileIndex = result.activeProfileIndex;

  renderProfileSelect();
  $('baseUrl').value = result.baseUrl;
  $('apiKey').value = result.apiKey;
  $('modelId').value = result.modelId;
  $('autoJapanese').checked = result.autoJapanese;
  $('autoEnglish').checked = result.autoEnglish;
  $('autoAll').checked = result.autoAll;
  $('hotkey').value = result.hotkey;
  $('targetLang').value = result.targetLang;
  $('enabled').checked = result.enabled;
  $('autoTranslateLimit').value = result.autoTranslateLimit;

  if (currentProfileIndex >= 0 && currentProfiles[currentProfileIndex]) {
    $('profileName').value = currentProfiles[currentProfileIndex].name || '';
  }

  updateProfileButtonStates();
}

function renderProfileSelect() {
  const select = $('profileSelect');
  select.innerHTML = '';

  if (currentProfiles.length === 0) {
    const opt = document.createElement('option');
    opt.value = '-1';
    opt.textContent = '（无配置，填写后点 + 保存）';
    select.appendChild(opt);
  } else {
    currentProfiles.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = p.name || `配置 ${i + 1}`;
      select.appendChild(opt);
    });
  }

  select.value = currentProfileIndex >= 0 ? currentProfileIndex : '-1';
}

function updateProfileButtonStates() {
  $('deleteProfile').disabled = currentProfiles.length === 0 || currentProfileIndex < 0;
}

function showProfileToast(message, type = 'info') {
  const toast = $('profileToast');
  toast.textContent = message;
  toast.className = `profile-toast profile-toast-${type} profile-toast-show`;
  setTimeout(() => {
    toast.classList.remove('profile-toast-show');
  }, 2500);
}

function highlightProfileFields() {
  const fields = ['profileName', 'baseUrl', 'apiKey', 'modelId'];
  fields.forEach(id => {
    const el = $(id);
    el.classList.add('field-highlight');
    setTimeout(() => el.classList.remove('field-highlight'), 600);
  });
}

function getCurrentFieldValues() {
  return {
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: $('apiKey').value.trim(),
    modelId: $('modelId').value.trim()
  };
}

function getSettingsFromUI() {
  const fields = getCurrentFieldValues();
  return {
    ...fields,
    llmProfiles: currentProfiles,
    activeProfileIndex: currentProfileIndex,
    autoJapanese: $('autoJapanese').checked,
    autoEnglish: $('autoEnglish').checked,
    autoAll: $('autoAll').checked,
    hotkey: $('hotkey').value,
    targetLang: $('targetLang').value,
    enabled: $('enabled').checked,
    autoTranslateLimit: parseInt($('autoTranslateLimit').value) || 0
  };
}

async function autoSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (currentProfileIndex >= 0 && currentProfiles[currentProfileIndex]) {
      const fields = getCurrentFieldValues();
      currentProfiles[currentProfileIndex] = {
        name: $('profileName').value.trim() || `配置 ${currentProfileIndex + 1}`,
        ...fields
      };
      const select = $('profileSelect');
      if (select.options[currentProfileIndex]) {
        select.options[currentProfileIndex].textContent = currentProfiles[currentProfileIndex].name;
      }
    }

    const settings = getSettingsFromUI();
    await chrome.storage.sync.set(settings);
    showStatus('✓ 已自动保存');
    notifyContentScript(settings);
  }, 500);
}

async function notifyContentScript(settings) {
  const tabs = await chrome.tabs.query({ url: SUPPORTED_TAB_URLS });

  await Promise.allSettled(tabs.map(async (tab) => {
    if (!tab.id) return;

    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings });
    } catch {
      // Content script not loaded in this tab yet.
    }
  }));
}

function showStatus(message, color = '#34a853') {
  const status = $('status');
  status.textContent = message;
  status.style.color = color;
  setTimeout(() => { status.textContent = ''; }, 2000);
}

// Profile management
$('addProfile').addEventListener('click', () => {
  const fields = getCurrentFieldValues();
  if (!fields.baseUrl || !fields.modelId) {
    showProfileToast('⚠ 请先填写 Base URL 和 Model ID', 'warn');
    highlightProfileFields();
    return;
  }
  const name = $('profileName').value.trim() || `配置 ${currentProfiles.length + 1}`;
  currentProfiles.push({ name, ...fields });
  currentProfileIndex = currentProfiles.length - 1;
  renderProfileSelect();
  $('profileSelect').value = currentProfileIndex;
  updateProfileButtonStates();

  showProfileToast(`✓ 已保存为「${name}」，共 ${currentProfiles.length} 个配置`, 'success');
  highlightProfileFields();
  autoSave();
});

$('deleteProfile').addEventListener('click', () => {
  if (currentProfiles.length === 0 || currentProfileIndex < 0) return;

  const deletedName = currentProfiles[currentProfileIndex].name || `配置 ${currentProfileIndex + 1}`;

  // Confirm before deleting
  const btn = $('deleteProfile');
  if (!btn.dataset.confirming) {
    btn.dataset.confirming = 'true';
    btn.textContent = '?';
    btn.title = `确认删除「${deletedName}」？再点一次确认`;
    showProfileToast(`再点一次确认删除「${deletedName}」`, 'warn');
    setTimeout(() => {
      delete btn.dataset.confirming;
      btn.textContent = '−';
      btn.title = '删除当前配置';
    }, 3000);
    return;
  }

  delete btn.dataset.confirming;
  btn.textContent = '−';
  btn.title = '删除当前配置';

  currentProfiles.splice(currentProfileIndex, 1);
  if (currentProfiles.length === 0) {
    currentProfileIndex = -1;
    $('profileName').value = '';
    $('baseUrl').value = '';
    $('apiKey').value = '';
    $('modelId').value = '';
  } else {
    currentProfileIndex = Math.min(currentProfileIndex, currentProfiles.length - 1);
    const profile = currentProfiles[currentProfileIndex];
    $('profileName').value = profile.name || '';
    $('baseUrl').value = profile.baseUrl || '';
    $('apiKey').value = profile.apiKey || '';
    $('modelId').value = profile.modelId || '';
  }
  renderProfileSelect();
  updateProfileButtonStates();

  const remaining = currentProfiles.length;
  showProfileToast(`✓ 已删除「${deletedName}」，剩余 ${remaining} 个配置`, 'danger');
  if (remaining > 0) highlightProfileFields();
  autoSave();
});

$('profileSelect').addEventListener('change', (e) => {
  currentProfileIndex = parseInt(e.target.value);
  if (currentProfileIndex >= 0 && currentProfiles[currentProfileIndex]) {
    const profile = currentProfiles[currentProfileIndex];
    $('profileName').value = profile.name || '';
    $('baseUrl').value = profile.baseUrl || '';
    $('apiKey').value = profile.apiKey || '';
    $('modelId').value = profile.modelId || '';

    showProfileToast(`已切换到「${profile.name || '配置 ' + (currentProfileIndex + 1)}」`, 'info');
    highlightProfileFields();
  }
  updateProfileButtonStates();
  autoSave();
});

// Auto-save on any input change
['profileName', 'baseUrl', 'apiKey', 'modelId', 'autoTranslateLimit'].forEach(id => {
  $(id).addEventListener('input', autoSave);
});

['autoJapanese', 'autoEnglish', 'autoAll', 'hotkey', 'targetLang', 'enabled'].forEach(id => {
  $(id).addEventListener('change', autoSave);
});

$('translatePage').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
      showStatus('✓ 翻译中，请稍候...');
      setTimeout(() => window.close(), 1000);
    } catch (err) {
      showStatus('无法连接到页面，请刷新后重试', '#ea4335');
    }
  }
});

loadSettings();

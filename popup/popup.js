// BiliCut - 弹窗页逻辑
const DEFAULTS = { autoCopy: true, includeAudio: true, format: 'png' };
let opts = { ...DEFAULTS };

const $ = (s) => document.querySelector(s);

function isBiliUrl(url) {
  return /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com\//i.test(url || '');
}

async function send(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isBiliUrl(tab.url)) return { error: 'notOnBili' };
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    return { error: 'noContent' };
  }
}

function setEnabled(on) {
  for (const id of ['#btn-shot', '#btn-rec', '#btn-link']) $(id).disabled = !on;
}

function updateRecBtn(rec) {
  const b = $('#btn-rec');
  b.classList.toggle('on', !!rec);
  b.querySelector('span').textContent = rec ? '停止截取' : '开始截取片段';
}

function renderStatus(res) {
  const el = $('#status');
  if (!res || res.error === 'notOnBili') {
    el.textContent = '请在 B 站视频页面使用';
    setEnabled(false);
    return;
  }
  if (res.error === 'noContent') {
    el.textContent = '未检测到助手，请刷新页面重试';
    setEnabled(false);
    return;
  }
  el.textContent =
    (res.found ? (res.title || '已就绪') : '未检测到视频，请先进入播放页') +
    (res.mode ? `（${res.mode}）` : '');
  setEnabled(!!res.found);
  updateRecBtn(res.recording);
}

$('#btn-shot').addEventListener('click', async () => {
  await send({ type: 'bcut-command', action: 'screenshot' });
});

$('#btn-rec').addEventListener('click', async () => {
  const res = await send({ type: 'bcut-command', action: 'record' });
  if (res && typeof res.recording === 'boolean') updateRecBtn(res.recording);
});

$('#btn-link').addEventListener('click', () => send({ type: 'bcut-command', action: 'link' }));

// ---------- 设置项 ----------
function reflect() {
  $('#opt-copy').checked = opts.autoCopy;
  $('#opt-audio').checked = opts.includeAudio;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.f === opts.format));
}

function save() {
  chrome.storage.sync.set({ bilicut_options: opts });
}

$('#opt-copy').addEventListener('change', (e) => { opts.autoCopy = e.target.checked; save(); });
$('#opt-audio').addEventListener('change', (e) => { opts.includeAudio = e.target.checked; save(); });
document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => { opts.format = b.dataset.f; reflect(); save(); })
);

chrome.storage.sync.get({ bilicut_options: DEFAULTS }, (r) => {
  opts = { ...opts, ...(r.bilicut_options || {}) };
  reflect();
});

send({ type: 'bcut-status' }).then(renderStatus);

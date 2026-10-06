// BiliCut - B站看番截图截段助手
// 内容脚本：在B站播放器右上角注入悬浮工具条，提供 截图 / 截取片段 / 复制分享链接 功能
(() => {
  if (window.__BILICUT_LOADED__) return;
  window.__BILICUT_LOADED__ = true;

  const DEFAULTS = { autoCopy: true, includeAudio: true, format: 'png' };
  let options = { ...DEFAULTS };

  const S = {
    recording: false,
    recorder: null,
    chunks: [],
    startTime: 0,
    raf: 0,
    timer: 0,
    silent: false,
    audioCtx: null,
    audioSource: null,
    audioSourceEl: null,
    audioDest: null,
    stream: null,
    canvas: null,
  };

  chrome.storage.sync.get({ bilicut_options: DEFAULTS }, (r) => {
    options = { ...options, ...(r.bilicut_options || {}) };
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync' && ch.bilicut_options) options = { ...options, ...ch.bilicut_options.newValue };
  });

  // ---------- 工具函数 ----------
  const pad = (n) => String(n).padStart(2, '0');

  function getVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!(v.videoWidth > 0)) continue;
      let w = 0;
      let h = 0;
      try {
        const r = v.getBoundingClientRect();
        w = r.width;
        h = r.height;
      } catch (e) { /* 忽略 */ }
      if (!w) { w = v.videoWidth; h = v.videoHeight; }
      const area = w * h;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    // 过滤掉首页预览小窗等过小的播放器
    return best && bestArea >= 200 * 150 ? best : null;
  }

  // 找到最近的定位祖先作为工具条挂载点（全屏时播放器容器会被全屏，挂在里面即可见）
  function getHost(video) {
    let el = video.parentElement;
    for (let i = 0; el && i < 10; i++) {
      if (el instanceof HTMLElement && getComputedStyle(el).position !== 'static') return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function videoTitle() {
    let t = (document.title || '').trim();
    const idx = t.search(/[-_—]\s*(哔哩哔哩|bilibili)/i);
    if (idx > 0) t = t.slice(0, idx);
    t = t.replace(/[\\/:*?"<>|]/g, ' ').trim();
    return (t || 'bilibili').slice(0, 60);
  }

  function nowStamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function fmtTime(s) {
    s = Math.floor(s);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    const h = Math.floor(m / 60);
    return h ? `${h}:${pad(m % 60)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  let toastTimer = 0;
  function toast(msg) {
    const bar = document.querySelector('.bcut-bar');
    let el = document.querySelector('.bcut-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'bcut-toast';
      ((bar && bar.parentElement) || document.body).appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('bcut-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('bcut-show'), 2200);
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function toPngBlob(blob) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png');
      };
      img.onerror = rej;
      img.src = URL.createObjectURL(blob);
    });
  }

  async function copyImage(blob) {
    try {
      const png = blob.type === 'image/png' ? blob : await toPngBlob(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) {
        return false;
      }
    }
  }

  // ---------- 功能：截图 ----------
  async function screenshot() {
    const video = getVideo();
    if (!video || !video.videoWidth) { toast('未找到可截图的视频'); return; }
    let blob = null;
    try {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(video, 0, 0);
      ctx.getImageData(0, 0, 1, 1); // 画布污染检测（DRM/跨域时抛错）
      const isJpg = options.format === 'jpg';
      blob = await new Promise((r) => c.toBlob(r, isJpg ? 'image/jpeg' : 'image/png', 0.95));
    } catch (e) {
      toast('截图失败：该视频画面受版权保护，无法访问');
      return;
    }
    if (!blob) { toast('截图失败，请重试'); return; }
    const ext = options.format === 'jpg' ? 'jpg' : 'png';
    saveBlob(blob, `${videoTitle()}_${nowStamp()}.${ext}`);
    let copied = false;
    if (options.autoCopy) copied = await copyImage(blob);
    toast(copied ? '已保存并复制到剪贴板，可直接粘贴给朋友' : '截图已保存');
  }

  // ---------- 功能：复制分享链接（含当前时间点） ----------
  async function shareLink() {
    const video = getVideo();
    const t = video ? video.currentTime : 0;
    try {
      const url = new URL(location.href);
      url.hash = '';
      url.searchParams.set('t', t.toFixed(1));
      const ok = await copyText(url.toString());
      toast(ok ? `分享链接已复制（定位到 ${fmtTime(t)}）` : '复制失败，请重试');
    } catch (e) {
      toast('复制失败');
    }
  }

  // ---------- 功能：截取视频片段 ----------
  function pickMime() {
    const list = [
      'video/mp4;codecs="avc1.640028,mp4a.40.2"',
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    for (const m of list) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* 继续 */ }
    }
    return '';
  }

  function attachAudio(video, stream) {
    try {
      S.audioCtx = S.audioCtx || new AudioContext();
      if (S.audioCtx.state === 'suspended') S.audioCtx.resume().catch(() => {});
      if (!S.audioSource || S.audioSourceEl !== video) {
        S.audioSource = S.audioCtx.createMediaElementSource(video);
        S.audioSourceEl = video;
        S.audioSource.connect(S.audioCtx.destination); // 保持正常外放
      }
      S.audioDest = S.audioCtx.createMediaStreamDestination();
      S.audioSource.connect(S.audioDest);
      S.audioDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch (e) {
      console.warn('[BiliCut] 音频捕获失败，仅录制画面', e);
      S.audioDest = null;
    }
  }

  async function startRecording() {
    const video = getVideo();
    if (!video || !video.videoWidth) { toast('未找到可截取的视频'); return false; }
    if (S.recording) return true;
    try {
      const c = S.canvas || (S.canvas = document.createElement('canvas'));
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(video, 0, 0, c.width, c.height);
      try {
        ctx.getImageData(0, 0, 1, 1); // 画布污染检测
      } catch (e) {
        toast('无法截取：该视频画面受版权保护');
        return false;
      }

      const stream = c.captureStream(30);
      S.stream = stream;
      if (options.includeAudio) attachAudio(video, stream);

      const mime = pickMime();
      S.recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : undefined);
      S.chunks = [];
      S.recorder.ondataavailable = (e) => { if (e.data && e.data.size) S.chunks.push(e.data); };
      S.recorder.onstop = onRecordStop;
      S.recorder.onerror = () => { toast('录制出错，已停止'); stopRecording(true); };
      S.recorder.start(500);
      S.recording = true;
      S.startTime = Date.now();

      const draw = () => {
        if (!S.recording) return;
        try {
          ctx.drawImage(video, 0, 0, c.width, c.height);
        } catch (e) {
          toast('录制中断：视频画面受保护');
          stopRecording(true);
          return;
        }
        S.raf = requestAnimationFrame(draw);
      };
      draw();
      updateRecUI();
      return true;
    } catch (e) {
      console.error('[BiliCut]', e);
      toast('无法开始截取：' + ((e && e.message) || e));
      cleanup();
      return false;
    }
  }

  function stopRecording(silent) {
    if (!S.recording) return;
    S.recording = false;
    S.silent = !!silent;
    cancelAnimationFrame(S.raf);
    clearInterval(S.timer);
    try { if (S.recorder && S.recorder.state !== 'inactive') S.recorder.stop(); } catch (e) { /* 忽略 */ }
    updateRecUI();
  }

  function onRecordStop() {
    const type = (S.recorder && S.recorder.mimeType) || 'video/webm';
    cleanup();
    updateRecUI();
    if (S.silent) { S.silent = false; return; }
    const blob = new Blob(S.chunks, { type: type.split(';')[0] });
    S.chunks = [];
    if (!blob.size) { toast('没有录到内容'); return; }
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    saveBlob(blob, `${videoTitle()}_片段_${nowStamp()}.${ext}`);
    toast('片段已保存，可在下载列表查看');
  }

  function cleanup() {
    cancelAnimationFrame(S.raf);
    clearInterval(S.timer);
    if (S.stream) {
      S.stream.getTracks().forEach((t) => { if (t.kind === 'video') t.stop(); });
      S.stream = null;
    }
    if (S.audioDest) {
      try { if (S.audioSource) S.audioSource.disconnect(S.audioDest); } catch (e) { /* 忽略 */ }
      S.audioDest = null;
    }
    S.recorder = null;
  }

  async function toggleRecord() {
    if (S.recording) { stopRecording(false); return; }
    const ok = await startRecording();
    if (ok) toast('开始截取，再次点击或按 Alt+Shift+R 结束');
  }

  // ---------- 悬浮工具条 UI ----------
  const ICONS = {
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    rec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  };

  function buildBar() {
    const bar = document.createElement('div');
    bar.className = 'bcut-bar';
    bar.innerHTML = `
      <span class="bcut-timer">● 00:00</span>
      <button class="bcut-btn" data-act="shot" title="截图当前画面（Alt+Shift+S）" aria-label="截图当前画面">${ICONS.camera}</button>
      <button class="bcut-btn" data-act="rec" title="截取片段（Alt+Shift+R）" aria-label="截取片段"><span class="bcut-ic-rec">${ICONS.rec}</span><span class="bcut-ic-stop">${ICONS.stop}</span></button>
      <button class="bcut-btn" data-act="link" title="复制分享链接（当前时间点）" aria-label="复制分享链接">${ICONS.link}</button>
    `;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.bcut-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'shot') screenshot();
      else if (act === 'rec') toggleRecord();
      else if (act === 'link') shareLink();
    });
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    bar.addEventListener('dblclick', (e) => e.stopPropagation());
    return bar;
  }

  function updateRecUI() {
    const bar = document.querySelector('.bcut-bar');
    if (!bar) return;
    bar.classList.toggle('bcut-active', S.recording);
    const recBtn = bar.querySelector('[data-act="rec"]');
    recBtn.classList.toggle('bcut-rec-on', S.recording);
    recBtn.title = S.recording ? '结束截取（Alt+Shift+R）' : '截取片段（Alt+Shift+R）';
    if (S.recording) {
      const el = bar.querySelector('.bcut-timer');
      clearInterval(S.timer);
      S.timer = setInterval(() => {
        const s = Math.floor((Date.now() - S.startTime) / 1000);
        el.textContent = `● ${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
      }, 400);
    }
  }

  function ensureUI() {
    const video = getVideo();
    if (!video) return;
    const host = getHost(video);
    if (!host) return;
    let bar = document.querySelector('.bcut-bar');
    if (bar && bar.isConnected && bar.parentElement === host) return;
    if (bar && bar.isConnected) bar.remove();
    bar = buildBar();
    if (host === document.body) bar.style.position = 'fixed';
    host.appendChild(bar);
  }

  // ---------- 消息（快捷键 / 弹窗） ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'bcut-status') {
      const v = getVideo();
      sendResponse({ found: !!(v && v.videoWidth), recording: S.recording, title: v ? videoTitle() : '' });
    } else if (msg.type === 'bcut-command') {
      if (msg.action === 'screenshot') screenshot();
      else if (msg.action === 'record') toggleRecord();
      else if (msg.action === 'link') shareLink();
      sendResponse({ ok: true, recording: S.recording });
    }
  });

  // ---------- 初始化 ----------
  let moQueued = false;
  const mo = new MutationObserver(() => {
    if (moQueued) return;
    moQueued = true;
    requestAnimationFrame(() => { moQueued = false; ensureUI(); });
  });

  function start() {
    mo.observe(document.body, { childList: true, subtree: true });
    ensureUI();
    setInterval(ensureUI, 2000); // 兜底：SPA 切换剧集后重新挂载
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

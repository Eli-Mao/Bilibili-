// BiliCut - B站看番截图截段助手
// 内容脚本：把 截图 / 截取片段 / 分享链接 按钮注入 B站原生播放器控制条，
// 随控制条一同出现和消失；控制条结构不匹配时回退为悬浮工具条。
(() => {
  if (window.__BILICUT_LOADED__) return;
  window.__BILICUT_LOADED__ = true;

  const VERSION = '1.1.5';
  console.log(`%c[BiliCut] v${VERSION} 已加载`, 'color:#fb7299;font-weight:bold');

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

  function classOf(el) {
    return (el && el.getAttribute && el.getAttribute('class')) || '';
  }

  // 播放器容器（全屏时被全屏化的元素）。注意要一路向上找到
  // bpx-player-container（它才包含控制条），不能停在视频包装层
  function getPlayerContainer(video) {
    let el = video;
    let generic = null;
    for (let i = 0; el && i < 12; i++) {
      const cls = classOf(el);
      if (cls.includes('bpx-player-container')) return el;
      if (cls.includes('bpx-player')) generic = el; // 记录最外层的 bpx 元素
      el = el.parentElement;
    }
    return generic || getHost(video);
  }

  // 最近的定位祖先（悬浮条/角标的挂载点）
  function getHost(video) {
    let el = video.parentElement;
    for (let i = 0; el && i < 10; i++) {
      if (el instanceof HTMLElement && getComputedStyle(el).position !== 'static') return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function findControlsRight(video) {
    const container = getPlayerContainer(video);
    const scope = container && container.isConnected ? container : document;
    // 首选：定位最后一个原生控制按钮（通常是全屏按钮），其父级即右侧按钮组。
    // 这样不依赖分组容器的类名，B站改版也不易失效。
    const btns = scope.querySelectorAll('.bpx-player-ctrl-btn');
    if (btns.length) {
      const last = btns[btns.length - 1];
      if (last && last.parentElement) return last.parentElement;
    }
    // 兜底：按类名找分组容器
    return (
      scope.querySelector('.bpx-player-controls-right') ||
      scope.querySelector('[class*="controls-right"]') ||
      scope.querySelector('.bpx-player-control-bottom-center') ||
      scope.querySelector('[class*="control-bottom-center"]')
    );
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
    const container = document.querySelector('.bpx-player-container') || document.querySelector('.bcut-bar');
    let el = document.querySelector('.bcut-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'bcut-toast';
      ((container && container.parentElement) || document.body).appendChild(el);
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
  // 逐个尝试编码格式：isTypeSupported 通过后仍要在构造器里再试一次，
  // 部分 Edge 版本两者表现不一致
  function createRecorder(stream) {
    const mimes = [
      'video/mp4;codecs="avc1.640028,mp4a.40.2"',
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const m of mimes) {
      try {
        if (MediaRecorder.isTypeSupported(m)) {
          return new MediaRecorder(stream, { mimeType: m, videoBitsPerSecond: 6000000 });
        }
      } catch (e) { /* 尝试下一个 */ }
    }
    return new MediaRecorder(stream); // 完全交给浏览器默认
  }

  // 音频捕获：任何一步失败或超时都必须放行，绝不能阻塞录制启动
  async function attachAudio(video, stream) {
    // 首选：AudioContext 重路由（限时等待，防止 resume() 悬挂导致录制卡死）
    try {
      S.audioCtx = S.audioCtx || new AudioContext();
      if (S.audioCtx.state !== 'running') {
        await Promise.race([
          S.audioCtx.resume().catch(() => {}),
          new Promise((r) => setTimeout(r, 1200)), // 超时上限：到点就走
        ]);
      }
      if (S.audioCtx.state === 'running') {
        if (!S.audioSource || S.audioSourceEl !== video) {
          S.audioSource = S.audioCtx.createMediaElementSource(video);
          S.audioSourceEl = video;
          S.audioSource.connect(S.audioCtx.destination); // 保持正常外放
        }
        S.audioDest = S.audioCtx.createMediaStreamDestination();
        S.audioSource.connect(S.audioDest);
        S.audioDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
        console.log('[BiliCut] 音频轨道已接入（AudioContext）');
        return;
      }
      console.warn('[BiliCut] AudioContext 未就绪，改用元素音轨');
    } catch (e) {
      console.warn('[BiliCut] AudioContext 路由失败，改用元素音轨', e);
    }
    // 兜底：直接取视频元素自身的音轨（无需重路由）
    try {
      if (typeof video.captureStream === 'function') {
        const tracks = video.captureStream().getAudioTracks();
        if (tracks.length) {
          tracks.forEach((t) => stream.addTrack(t));
          console.log('[BiliCut] 音频轨道已接入（元素 captureStream）');
          return;
        }
      }
    } catch (e) {
      console.warn('[BiliCut] 元素音轨捕获失败', e);
    }
    console.warn('[BiliCut] 本次仅录制画面（无音频）');
  }

  async function startRecording() {
    console.log('[BiliCut] startRecording: 开始');
    const video = getVideo();
    if (!video || !video.videoWidth) { toast('未找到可截取的视频'); return false; }
    if (S.recording) return true;
    if (typeof MediaRecorder === 'undefined') {
      toast('当前浏览器不支持 MediaRecorder，无法截取片段');
      return false;
    }
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
      console.log('[BiliCut] 画布就绪', c.width + 'x' + c.height);

      const stream = c.captureStream(30);
      S.stream = stream;
      console.log('[BiliCut] 画布流已创建');
      if (options.includeAudio) await attachAudio(video, stream);
      console.log('[BiliCut] 音频处理完成，轨道数:', stream.getTracks().length);

      try {
        S.recorder = createRecorder(stream);
      } catch (e) {
        console.error('[BiliCut] MediaRecorder 创建失败', e);
        toast('录制初始化失败：' + ((e && e.message) || e));
        cleanup();
        return false;
      }
      console.log('[BiliCut] MediaRecorder 已创建', S.recorder.mimeType);
      S.chunks = [];
      S.recorder.ondataavailable = (e) => { if (e.data && e.data.size) S.chunks.push(e.data); };
      S.recorder.onstop = onRecordStop;
      S.recorder.onerror = (e) => {
        console.error('[BiliCut] 录制出错', e && e.error);
        toast('录制出错，已停止');
        stopRecording(true);
      };
      try {
        S.recorder.start(500); // 每 500ms 收一次数据
      } catch (e) {
        S.recorder.start(); // 退化为停止时一次性收集
      }
      S.recording = true;
      S.startTime = Date.now();
      console.log('[BiliCut] 录制已启动');

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
    console.log('[BiliCut] toggleRecord 被调用, recording =', S.recording);
    try {
      if (S.recording) { stopRecording(false); toast('正在生成片段文件…'); return; }
      const ok = await startRecording();
      if (ok) toast('开始截取，再次点击或按 Alt+Shift+R 结束');
    } catch (e) {
      console.error('[BiliCut] 截取流程异常', e);
      toast('截取失败：' + ((e && e.message) || e));
      stopRecording(true);
    }
  }

  // ---------- 统一动作入口（600ms 防抖，避免快捷键 + 按钮 双触发） ----------
  let lastAction = 0;
  async function runAction(action) {
    const now = Date.now();
    if (now - lastAction < 600) return;
    lastAction = now;
    if (action === 'screenshot') return screenshot();
    if (action === 'record' || action === 'rec') return toggleRecord();
    if (action === 'link') return shareLink();
    console.warn('[BiliCut] 未知动作:', action);
  }

  // ---------- 图标 ----------
  const ICONS = {
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    rec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  };

  // ---------- 控制条按钮（注入 B站原生控制条） ----------
  function wireBtn(btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      runAction(btn.dataset.act);
    });
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    return btn;
  }

  function buildCtrlBtn(icon, act, text) {
    const b = document.createElement('div');
    // 注意：不要复用 bpx-player-ctrl-btn 原生类名，避免被B站的检测/重渲染逻辑干扰
    b.className = 'bcut-ctrl-btn';
    b.dataset.act = act;
    b.dataset.text = text;
    b.title = text;
    b.innerHTML = `<span class="bcut-ic">${icon}</span>`;
    return wireBtn(b);
  }

  function buildRecCtrlBtn() {
    const b = document.createElement('div');
    b.className = 'bcut-ctrl-btn';
    b.dataset.act = 'record'; // 与 runAction 的动作名保持一致
    b.dataset.text = '截取片段（Alt+Shift+R）';
    b.title = '截取片段（Alt+Shift+R）';
    b.innerHTML = `<span class="bcut-ic bcut-ic-rec">${ICONS.rec}</span><span class="bcut-ic bcut-ic-stop">${ICONS.stop}</span>`;
    return wireBtn(b);
  }

  function mountCtrlGroup(ctrl) {
    let group = ctrl.querySelector('.bcut-ctrl-group');
    if (group && group.isConnected) return;
    if (group) group.remove();
    group = document.createElement('div');
    group.className = 'bcut-ctrl-group';
    group.appendChild(buildCtrlBtn(ICONS.camera, 'screenshot', '截图当前画面（Alt+Shift+S）'));
    group.appendChild(buildRecCtrlBtn());
    group.appendChild(buildCtrlBtn(ICONS.link, 'link', '复制分享链接（当前时间点）'));
    const fsBtn =
      ctrl.querySelector('.bpx-player-ctrl-fullscreen') ||
      ctrl.querySelector('[class*="ctrl-fullscreen"]');
    if (fsBtn && fsBtn.parentElement === ctrl) ctrl.insertBefore(group, fsBtn);
    else ctrl.appendChild(group);
  }

  // ---------- 录制角标（控制条隐藏时也可见，全屏可用） ----------
  function mountBadge(container) {
    let badge = document.querySelector('.bcut-recbadge');
    if (badge && badge.isConnected && badge.parentElement === container) return;
    if (badge) badge.remove();
    badge = document.createElement('div');
    badge.className = 'bcut-recbadge';
    badge.innerHTML = '<span class="bcut-dot"></span><span class="bcut-timetext">00:00</span>';
    if (container === document.body) badge.style.position = 'fixed';
    container.appendChild(badge);
  }

  // ---------- 悬浮工具条（控制条结构不匹配时的回退方案） ----------
  function buildBar() {
    const bar = document.createElement('div');
    bar.className = 'bcut-bar';
    bar.innerHTML = `
      <span class="bcut-timer">● 00:00</span>
      <button class="bcut-btn" data-act="screenshot" title="截图当前画面（Alt+Shift+S）" aria-label="截图当前画面">${ICONS.camera}</button>
      <button class="bcut-btn" data-act="record" title="截取片段（Alt+Shift+R）" aria-label="截取片段"><span class="bcut-ic bcut-ic-rec">${ICONS.rec}</span><span class="bcut-ic bcut-ic-stop">${ICONS.stop}</span></button>
      <button class="bcut-btn" data-act="link" title="复制分享链接（当前时间点）" aria-label="复制分享链接">${ICONS.link}</button>
    `;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.bcut-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      runAction(btn.dataset.act);
    });
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    bar.addEventListener('dblclick', (e) => e.stopPropagation());
    return bar;
  }

  // ---------- 录制状态 UI ----------
  function updateRecUI() {
    const on = S.recording;
    document.querySelectorAll('[data-act="record"]').forEach((b) => {
      b.classList.toggle('bcut-rec-on', on);
      b.title = on ? '结束截取（Alt+Shift+R）' : '截取片段（Alt+Shift+R）';
      if ('text' in b.dataset) b.dataset.text = b.title;
    });
    document.querySelectorAll('.bcut-bar').forEach((bar) => bar.classList.toggle('bcut-active', on));
    const badge = document.querySelector('.bcut-recbadge');
    if (badge) badge.classList.toggle('bcut-on', on);
    clearInterval(S.timer);
    if (on) {
      S.timer = setInterval(() => {
        const s = Math.floor((Date.now() - S.startTime) / 1000);
        const txt = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
        document.querySelectorAll('.bcut-timetext').forEach((el) => (el.textContent = txt));
        const t = document.querySelector('.bcut-bar .bcut-timer');
        if (t) t.textContent = '● ' + txt;
      }, 400);
    }
  }

  // ---------- 挂载调度 ----------
  let uiMode = '';
  function setMode(mode) {
    if (uiMode === mode) return;
    uiMode = mode;
    console.log(`[BiliCut] UI模式: ${mode}`);
  }

  function ensureUI() {
    const video = getVideo();
    if (!video) return;
    const container = getPlayerContainer(video);
    if (container) mountBadge(container);

    const ctrl = findControlsRight(video);
    if (ctrl) {
      // 清理残留：移除所有不在当前插入点（或重复）的按钮组，防止越积越多
      const scope = container && container.isConnected ? container : document;
      scope.querySelectorAll('.bcut-ctrl-group').forEach((g) => {
        if (g.parentElement !== ctrl) g.remove();
      });
      let first = true;
      ctrl.querySelectorAll('.bcut-ctrl-group').forEach((g) => {
        if (first) first = false;
        else g.remove();
      });
      mountCtrlGroup(ctrl);
      const fb = document.querySelector('.bcut-bar'); // 已有原生控制条时移除回退悬浮条
      if (fb) fb.remove();
      setMode('原生控制条');
    } else {
      setMode('悬浮条（回退，控制条未匹配）');
      const host = container || getHost(video);
      let bar = document.querySelector('.bcut-bar');
      if (bar && bar.isConnected && bar.parentElement === host) return;
      if (bar && bar.isConnected) bar.remove();
      bar = buildBar();
      if (host === document.body) bar.style.position = 'fixed';
      host.appendChild(bar);
    }
  }

  // ---------- 快捷键（页面内直接监听，全屏有效，不依赖浏览器注册） ----------
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || !e.shiftKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'KeyS') {
        e.preventDefault();
        e.stopPropagation();
        runAction('screenshot');
      } else if (e.code === 'KeyR') {
        e.preventDefault();
        e.stopPropagation();
        runAction('record');
      }
    },
    true
  );

  // ---------- 消息（浏览器快捷键命令 / 弹窗） ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'bcut-status') {
      const v = getVideo();
      sendResponse({ found: !!(v && v.videoWidth), recording: S.recording, title: v ? videoTitle() : '', mode: uiMode });
      return;
    }
    if (msg.type === 'bcut-command') {
      runAction(msg.action).finally(() => sendResponse({ ok: true, recording: S.recording }));
      return true; // 异步响应
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
    setInterval(ensureUI, 2000); // 兜底：SPA 切换剧集/播放器重建后重新挂载
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

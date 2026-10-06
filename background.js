// BiliCut - 后台 Service Worker：快捷键转发 + 跨域视频的标签页截屏兜底
chrome.commands.onCommand.addListener(async (command) => {
  const action =
    command === 'take-screenshot' ? 'screenshot' :
    command === 'toggle-record' ? 'record' : null;
  if (!action) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'bcut-command', action }, () => void chrome.runtime.lastError);
  } catch (e) { /* 忽略 */ }
});

// 跨域视频无法从画布取像素时，由内容脚本请求截取可见标签页。
// 若请求来自 iframe（如苹果CMS/MacPlayer 这类把播放器嵌在框架里的站点），
// 还要向顶层框架索取 iframe 的位置信息，供裁剪时换算坐标
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'bcut-tab-title') {
    chrome.tabs.get(sender.tab.id, (t) => sendResponse({ title: (t && t.title) || '' }));
    return true; // 异步响应
  }

  if (msg.type !== 'bcut-capture-tab') return;
  const tabId = sender.tab && sender.tab.id;
  const windowId = sender.tab && sender.tab.windowId;
  chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
    if (chrome.runtime.lastError || !dataUrl) {
      sendResponse({ error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'captureVisibleTab failed' });
      return;
    }
    if (!tabId || sender.frameId === 0) {
      sendResponse({ dataUrl });
      return;
    }
    // 子框架：向顶层框架索取所有 iframe 的位置
    chrome.tabs.sendMessage(tabId, { type: 'bcut-frame-info' }, { frameId: 0 }, (info) => {
      if (chrome.runtime.lastError) info = null;
      sendResponse({ dataUrl, frameInfo: info || null });
    });
  });
  return true; // 异步响应
});

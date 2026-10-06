// BiliCut - 后台 Service Worker：负责把键盘快捷键转发给当前标签页的内容脚本
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

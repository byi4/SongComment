/**
 * MoeKoeMusic Comment Plugin — Popup 设置界面逻辑
 * 通过 chrome.tabs 查询当前播放器页面的 localStorage 状态
 */

document.addEventListener('DOMContentLoaded', async () => {
  // 从 manifest 获取版本号
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('version-text');
  if (versionEl && manifest.version) {
    versionEl.textContent = `Song Comment v${manifest.version}`;
  }

  const els = {
    currentSong: document.getElementById('current-song'),
    commentCount: document.getElementById('comment-count'),
    loginStatus: document.getElementById('login-status'),
    clearCache: document.getElementById('clear-cache'),
    statusMsg: document.getElementById('status-msg'),
  };

  // 获取当前活动标签页
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch (e) {
    // 可能不在扩展环境（如直接打开 HTML）
    els.currentSong.textContent = '非扩展环境';
    els.loginStatus.textContent = '未知';
    return;
  }

// 注入脚本读取页面状态
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        function getSong() {
          try {
            const str = localStorage.getItem('current_song');
            return str ? JSON.parse(str) : null;
          } catch { return null; }
        }
        function getMoeData() {
          try {
            const str = localStorage.getItem('MoeData');
            return str ? JSON.parse(str) : null;
          } catch { return null; }
        }
        
        async function fetchCommentCount() {
          try {
            const songStr = localStorage.getItem('current_song');
            if (!songStr) return '-';
            const song = JSON.parse(songStr);
            if (!song || !song.hash) return '-';
            
            // 先尝试从 current_song 读取 album_audio_id
            let mixsongid = song.album_audio_id;
            
            // 如果 album_audio_id 不可用，调 /privilege/lite 解析
            if (!mixsongid) {
              const moeDataStr = localStorage.getItem('MoeData');
              const moeData = moeDataStr ? JSON.parse(moeDataStr) : null;
              const token = moeData?.UserInfo?.token || '';
              const resolveUrl = `http://127.0.0.1:6521/privilege/lite?hash=${encodeURIComponent(song.hash)}`;
              const resolveRes = await fetch(resolveUrl, { headers: { 'Authorization': token } });
              if (resolveRes.ok) {
                const resolveData = await resolveRes.json();
                mixsongid = resolveData?.data?.[0]?.album_audio_id;
              }
            }
            
            if (!mixsongid) return '-';
            
            const moeDataStr = localStorage.getItem('MoeData');
            const moeData = moeDataStr ? JSON.parse(moeDataStr) : null;
            const token = moeData?.UserInfo?.token || '';
            
            const url = `http://127.0.0.1:6521/comment/music?mixsongid=${encodeURIComponent(mixsongid)}&page=1&pagesize=1`;
            const res = await fetch(url, { headers: { 'Authorization': token } });
            if (!res.ok) return '-';
            const data = await res.json();
            
            let total = data?.count || data?.total || data?.data?.total || 0;
            return total > 999 ? '999+' : String(total);
          } catch { return '-'; }
        }
        
        const song = getSong();
        const moeData = getMoeData();
        const commentCount = await fetchCommentCount();
        
        return { song, moeData, commentCount };
      },
    });

    const state = results[0] && results[0].result;

    // 显示当前歌曲
    if (state && state.song) {
      els.currentSong.textContent = state.song.name || state.song.hash || '未知';
    } else {
      els.currentSong.textContent = '无播放';
    }

    // 显示评论数
    if (state && state.commentCount) {
      els.commentCount.textContent = state.commentCount;
    } else {
      els.commentCount.textContent = '-';
    }

    // 显示登录状态
    if (state && state.moeData && state.moeData.UserInfo && state.moeData.UserInfo.token) {
      els.loginStatus.textContent = '已登录';
      els.loginStatus.className = 'value good';
    } else {
      els.loginStatus.textContent = '未登录';
      els.loginStatus.className = 'value bad';
    }

  } catch (e) {
    els.currentSong.textContent = '无法访问页面';
    els.loginStatus.textContent = '未知';
    console.warn('[MoeKoeMusic Comment Popup] 读取状态失败:', e.message);
  }

  // 清除缓存按钮
  els.clearCache.addEventListener('click', async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // 触发 content.js 的缓存清除
          window.postMessage({ type: 'MOEKoe_COMMENT_CLEAR_CACHE' }, '*');
        },
      });
      els.statusMsg.textContent = '缓存已清除 ✓';
      setTimeout(() => { els.statusMsg.textContent = ''; }, 2000);
    } catch (e) {
      els.statusMsg.textContent = '清除失败';
      els.statusMsg.style.color = '#e74c3c';
    }
  });
});

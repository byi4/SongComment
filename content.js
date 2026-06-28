// ==UserScript==
// @name         MoeKoeMusic Comment
// @description  浏览歌曲评论
// @version      1.0.0
// ==/UserScript==

console.log('[MoeKoeMusic Comment] 插件已加载 v1.0.0');
console.log('%c[MoeKoeMusic Comment] ✅ 插件已注入页面', 'color: #e74c3c; font-size: 16px; font-weight: bold;');
console.log('%c[MoeKoeMusic Comment] 📍 查找入口: 底部播放器.song-title-row 区域', 'color: #e74c3c;');
console.log('[MoeKoeMusic Comment] document.readyState=' + document.readyState);
console.log('[MoeKoeMusic Comment] 当前 .extra-controls 检查 ' + (document.querySelector('.extra-controls') ? '存在' : '不存在'));

/**
 * 从 localStorage 读取用户认证信息，构建 API 请求头
 * KuGouMusicApi 的 request.js 会自动附加以下头部：
 * - token: 用户令牌
 * - userid: 用户 ID
 * - dfid: 设备 ID
 * - mid: KUGOU_API_MID
 * - guid: KUGOU_API_GUID
 * @returns {Object} headers 对象，包含所有认证头
 */
function getAuthHeaders() {
  const headers = {};
  try {
    const moeDataStr = localStorage.getItem('MoeData');
    if (!moeDataStr) {
      console.log('[MoeKoeMusic Comment] 未找到 MoeData（未登录状态）');
      return headers;
    }
    const moeData = JSON.parse(moeDataStr);
    // 提取认证字段
    if (moeData.token) headers['token'] = moeData.token;
    if (moeData.userid) headers['userid'] = String(moeData.userid);
    if (moeData.dfid) headers['dfid'] = moeData.dfid;
    if (moeData.KUGOU_API_MID) headers['mid'] = moeData.KUGOU_API_MID;
    if (moeData.KUGOU_API_GUID) headers['guid'] = moeData.KUGOU_API_GUID;
    // 兼容不同版本（可能字段在 user 子对象中）
    if (moeData.user && moeData.user.token && !headers['token']) {
      headers['token'] = moeData.user.token;
    }
    console.log('[MoeKoeMusic Comment] 已加载认证头:', Object.keys(headers));
  } catch (e) {
    console.warn('[MoeKoeMusic Comment] 解析 MoeData 失败:', e.message);
  }
  return headers;
}

// ====== 评论数据流水线 ======

/** mixsongid 缓存 (hash → album_audio_id) */
const mixsongidCache = new Map();

/** 评论列表缓存 <key, {data, timestamp}>，TTL 120 秒 */
const commentListCache = new Map();
/** 缓存 TTL（毫秒） */
const CACHE_TTL = 120 * 1000;

/**
 * 从缓存中读取数据
 * @param {string} key - 缓存键
 * @param {Map} cache - 缓存 Map 对象
 * @returns {*|null} 缓存数据或 null
 */
function getFromCache(key, cache) {
  if (!cache.has(key)) return null;
  const entry = cache.get(key);
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * 写入缓存
 * @param {string} key - 缓存
 * @param {*} data - 缓存数据
 * @param {Map} cache - 缓存 Map 对象
 */
function setToCache(key, data, cache) {
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * 带重试机制的异步函数包装器
 * @param {Function} fn - 要重试的异步函数
 * @param {number} [maxRetries=3] - 最大重试次数
 * @param {number} [baseDelay=2000] - 基础延迟（毫秒）
 * @returns {Promise<*>} fn 的返回值
 */
async function withRetry(fn, maxRetries = 3, baseDelay = 2000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // AbortError 不重试
      if (e.name === 'AbortError') throw e;
      lastError = e;
      if (attempt < maxRetries) {
        // 指数退避：2s, 4s, 8s...
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`[MoeKoeMusic Comment] 请求失败，${delay/1000}s 后第 ${attempt + 1} 次重试`, e.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/** 全局 AbortController，用于取消进行中的评论请求 */
let currentCommentAbortController = null;

/**
 * 通过歌曲 hash 解析 mixsongid (album_audio_id)
 * @param {string} hash - 歌曲 hash
 * @param {AbortSignal} [signal] - 可选取消信号
 * @returns {Promise<string|null>} album_audio_id 或 null
 */
async function resolveMixSongId(hash, signal) {
  if (!hash) {
    console.warn('[MoeKoeMusic Comment] resolveMixSongId: hash 为空');
    return null;
  }

  // 检查缓存
  if (mixsongidCache.has(hash)) {
    return mixsongidCache.get(hash);
  }

  // 优先从 current_song 对象中读取 album_audio_id（无需 API 调用）
  try {
    const song = getCurrentSong();
    if (song && song.album_audio_id != null) {
      const mixsongid = String(song.album_audio_id);
      mixsongidCache.set(hash, mixsongid);
      console.log('[MoeKoeMusic Comment] 解析 mixsongid=' + mixsongid + ' (hash=' + hash + ', current_song.album_audio_id)');
      return mixsongid;
    }
  } catch (e) {
    // 忽略，继续走 API 流程
  }

  const API_BASE = 'http://127.0.0.1:6521';
  const url = `${API_BASE}/privilege/lite?hash=${encodeURIComponent(hash)}`;
  const headers = getAuthHeaders();

  try {
    console.log(`[MoeKoeMusic Comment] 请求 mixsongid: ${url}`);

    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        // 如果外部有取消信号，连接到内部
        if (signal) {
          signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        return res;
      } finally {
        clearTimeout(timeoutId);
      }
    });

    const data = await response.json();
    console.log('[MoeKoeMusic Comment] /privilege/lite 响应:', data);
    console.log('[MoeKoeMusic Comment] /privilege/lite keys:', Object.keys(data));
    console.log('[MoeKoeMusic Comment] /privilege/lite full:', JSON.stringify(data).substring(0, 500));

    // 主路径：data.data[0].album_audio_id（/privilege/lite endpoint）
    if (data && data.data && Array.isArray(data.data) && data.data.length > 0 && data.data[0].album_audio_id != null) {
      const mixsongid = String(data.data[0].album_audio_id);
      mixsongidCache.set(hash, mixsongid);
      console.log('[MoeKoeMusic Comment] 解析 mixsongid=' + mixsongid + ' (hash=' + hash + ', /privilege/lite endpoint)');
      return mixsongid;
    }

    // === 以下为向后兼容的降级路径 ===

    // 响应格式预期为数组，取第一个元素的 album_audio_id
    if (Array.isArray(data) && data.length > 0 && data[0].album_audio_id) {
      const mixsongid = String(data[0].album_audio_id);
      mixsongidCache.set(hash, mixsongid);
      console.log(`[MoeKoeMusic Comment] 解析 mixsongid=${mixsongid} (hash=${hash})`);
      return mixsongid;
    }

    // 兼容 { data: [...] } 包装格式
    if (data && Array.isArray(data.data) && data.data.length > 0 && data.data[0].album_audio_id) {
      const mixsongid = String(data.data[0].album_audio_id);
      mixsongidCache.set(hash, mixsongid);
      console.log(`[MoeKoeMusic Comment] 解析 mixsongid=${mixsongid} (hash=${hash}, data.data)`);
      return mixsongid;
    }

    // 兜底：遍历 data.data[0] 尝试已知字段
    if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
      const firstItem = data.data[0];
      console.log('[MoeKoeMusic Comment] /privilege/lite data.data[0] all keys:', Object.keys(firstItem));
      if (firstItem.album_audio_id) {
        const mixsongid = String(firstItem.album_audio_id);
        mixsongidCache.set(hash, mixsongid);
        console.log('[MoeKoeMusic Comment] 解析 mixsongid=' + mixsongid + ' (hash=' + hash + ', data.data[0].album_audio_id)');
        return mixsongid;
      }
    }

    // 兼容 data.images 格式
    if (data && Array.isArray(data.images) && data.images.length > 0 && data.images[0].album_audio_id) {
      const mixsongid = String(data.images[0].album_audio_id);
      mixsongidCache.set(hash, mixsongid);
      console.log('[MoeKoeMusic Comment] 解析 mixsongid=' + mixsongid + ' (hash=' + hash + ', data.images)');
      return mixsongid;
    }

    console.warn('[MoeKoeMusic Comment] /privilege/lite 响应中未找到可用的 mixsongid 字段:', data);
    return null;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log('[MoeKoeMusic Comment] resolveMixSongId 被取消');
      return null;
    }
    console.error('[MoeKoeMusic Comment] 解析 mixsongid 失败:', e.message);
    return null;
  }
}

/**
 * 获取指定 mixsongid 的评论列表
 * @param {string} mixsongid - 专辑音频 ID
 * @param {number} [page=1] - 页码
 * @param {number} [pageSize=20] - 每页数量
 * @param {AbortSignal} [signal] - 可选取消信号
 * @returns {Promise<{comments: Array, total: number, page: number, pagesize: number, hasMore: boolean}>}
 */
async function fetchComments(mixsongid, page = 1, pageSize = 30, signal) {
  if (!mixsongid) {
    console.warn('[MoeKoeMusic Comment] fetchComments: mixsongid 为空');
    return { comments: [], total: 0, page, pagesize: pageSize, hasMore: false };
  }

  const API_BASE = 'http://127.0.0.1:6521';
  const url = `${API_BASE}/comment/music?mixsongid=${encodeURIComponent(mixsongid)}&page=${page}&pagesize=${pageSize}`;
  const headers = getAuthHeaders();

  try {
    console.log(`[MoeKoeMusic Comment] 请求评论列表: ${url}`);
    const response = await fetch(url, { headers, signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    console.log('[MoeKoeMusic Comment] /comment/music 响应:', data);

    // 响应处理：兼容不同格式
    let comments = [];
    let total = 0;

    if (Array.isArray(data)) {
      comments = data;
    } else if (data && Array.isArray(data.list)) {
      comments = data.list;
      total = data.count || comments.length;
    } else if (data && Array.isArray(data.comments)) {
      comments = data.comments;
      total = data.total || comments.length;
    } else if (data && Array.isArray(data.data)) {
      comments = data.data;
      total = data.total || comments.length;
    } else if (data && data.data && Array.isArray(data.data.comments)) {
      comments = data.data.comments;
      total = data.data.total || comments.length;
    }

    // 如果 total 为 0 且 comments 有数据，用 comments.length
    if (total === 0 && comments.length > 0) {
      total = comments.length;
    }

    const hasMore = page * pageSize < total;

    return { comments, total, page, pagesize: pageSize, hasMore };
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log('[MoeKoeMusic Comment] fetchComments 被取消');
      return { comments: [], total: 0, page, pagesize: pageSize, hasMore: false };
    }
    console.error('[MoeKoeMusic Comment] 获取评论列表失败:', e.message);
    return { comments: [], total: 0, page, pagesize: pageSize, hasMore: false };
  }
}

// ====== 徽章系统 ======

/** DOM 观察器 */
let badgeObserver = null;

/**
 * 从 localStorage 读取当前播放歌曲信息
 * @returns {Object|null} 歌曲对象（含 hash, name, author 等字段），无播放状态时返回 null
 */
function getCurrentSong() {
  try {
    const str = localStorage.getItem('current_song');
    if (!str) return null;
    return JSON.parse(str);
  } catch (e) {
    console.warn('[MoeKoeMusic Comment] 解析 current_song 失败:', e.message);
    return null;
  }
}



/**
 * 获取评论用户显示名
 * @param {Object} item - 评论或回复对象
 * @returns {string} 用户名
 */
function getCommentAuthorName(item) {
  if (!item) return '';
  return item.nickname || item.user_name || item.username || '';
}

/**
 * 获取评论用户 ID
 * @param {Object} item - 评论或回复对象
 * @returns {string} 用户 ID
 */
function getCommentAuthorId(item) {
  if (!item) return '';
  return String(item.user_id || item.userid || item.uid || '').trim();
}

/**
 * 获取回复目标用户 ID
 * @param {Object} item - 回复对象
 * @returns {string} 回复目标用户 ID
 */
function getReplyTargetUserId(item) {
  if (!item) return '';
  const targetId = item.puser_id || item.parent_user_id || item.reply_user_id || item.reply_to_user_id || '';
  const normalized = String(targetId).trim();
  return normalized === '0' ? '' : normalized;
}

/**
 * 标准化用于比较的用户名
 * @param {string} name - 用户名
 * @returns {string} 标准化后的用户名
 */
function normalizeCommentAuthorName(name) {
  return String(name || '').trim().replace(/^@+/, '').trim();
}

/**
 * 只去除回复楼主时附带的引用内容（`//@楼主:` 及其之后的内容）
 * @param {string} text - 原始评论内容
 * @param {Object} reply - 回复对象
 * @param {Object} parentComment - 楼主评论对象
 * @returns {string} 处理后的内容
 */
function stripQuotedReplyToParent(text, reply, parentComment) {
  if (!text) return '';

  const idx = text.indexOf('//@');
  if (idx === -1) return text;

  const replyTargetId = getReplyTargetUserId(reply);
  const parentAuthorId = getCommentAuthorId(parentComment);
  if (replyTargetId && parentAuthorId) {
    return replyTargetId === parentAuthorId ? text.substring(0, idx).trim() : text;
  }

  const quote = text.substring(idx);
  const match = quote.match(/^\/\/@\s*([^:：]+)\s*[:：]/);
  if (!match) return text;

  const quotedAuthor = normalizeCommentAuthorName(match[1]);
  const parentAuthor = normalizeCommentAuthorName(getCommentAuthorName(parentComment));
  return quotedAuthor && parentAuthor && quotedAuthor === parentAuthor
    ? text.substring(0, idx).trim()
    : text;
}

/**
 * 创建 FontAwesome 评论图标
 * @returns {HTMLElement}
 */
function createCommentIcon() {
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-comment-dots';
  return icon;
}

/**
 * 注入评论徽章按钮到 .extra-controls
 * @param {HTMLElement} container - .extra-controls 元素
 */
function injectBadge(container) {
  // 避免重复注入
  if (document.getElementById('moekoe-comment-extra-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'extra-btn';
  btn.id = 'moekoe-comment-extra-btn';
  btn.title = '查看评论';
  btn.style.cssText = 'background: none; border: none; font-size: 16px; cursor: pointer; padding: 0 8px; color: #777; opacity: 0; transform: scale(0.8); transition: opacity 0.3s ease, transform 0.3s ease;';

  // 评论图标
  btn.appendChild(createCommentIcon());

  // 保存按钮引用供后续面板使用
  window.__commentBtn = btn;

  // 点击事件：切换评论面板
  btn.addEventListener('click', () => {
    const song = getCurrentSong();
    const songName = song && song.name ? song.name : '评论';
    if (window.__commentPanel) {
      window.__commentPanel.toggle(songName);
    }
  });

  // 插入到歌词按钮之后，播放速度按钮之前
  container.insertBefore(btn, container.querySelector('.playback-speed'));

  // 下一帧触发淡入动画（避免突兀出现）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      btn.style.opacity = '1';
      btn.style.transform = 'scale(1)';
    });
  });

  console.log('[MoeKoeMusic Comment] ✅ 评论按钮已注入到:', container.tagName + '.' + (container.className || ''));
}

/**
 * 初始化评论徽章系统 - 注入到 .song-title-row
 */
function initBadge() {
  let attempts = 0;
  const maxAttempts = 60;
  console.log('[MoeKoeMusic Comment] initBadge() 被调用，document.readyState=' + document.readyState);

  function tryInject() {
    attempts++;
    if (!document.getElementById('moekoe-comment-extra-btn')) {
      const extraControls = document.querySelector('.extra-controls');
      if (extraControls) {
        injectBadge(extraControls);
        console.log('[MoeKoeMusic Comment] 按钮注入成功 (第' + attempts + '次)');
        return true;
      }
    }
    return false;
  }

  // 立即尝试
  if (tryInject()) return;

  // 30 秒超时警告
  const timeoutId = setTimeout(() => {
    console.warn('[MoeKoeMusic Comment] ⚠️ MutationObserver 30秒超时');
  }, 30000);

  // MutationObserver
  if (badgeObserver) {
    badgeObserver.disconnect();
    badgeObserver = null;
  }

  badgeObserver = new MutationObserver(() => {
    if (tryInject()) {
      clearTimeout(timeoutId);
      badgeObserver.disconnect();
      badgeObserver = null;
    }
  });

  badgeObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
  console.log('[MoeKoeMusic Comment] MutationObserver 已启动');

  // 轮询回退 2秒间隔，最多60次（2分钟）
  const pollInterval = setInterval(() => {
    if (tryInject()) {
      clearInterval(pollInterval);
      clearTimeout(timeoutId);
      if (badgeObserver) {
        badgeObserver.disconnect();
        badgeObserver = null;
      }
      console.log('[MoeKoeMusic Comment] ✅ 轮询成功注入按钮');
    } else if (attempts >= maxAttempts) {
      clearInterval(pollInterval);
      console.error('[MoeKoeMusic Comment] ❌ 轮询超时，2分钟内未找到 .song-title-row 或 .extra-controls');
    }
  }, 2000);
}

// ====== 评论面板系统 ======

/** 面板 Shadow DOM 根容器引用 */
let panelRoot = null;

/**
 * 初始化右侧滑评论面板（Shadow DOM mode: 'closed' 样式隔离）
 */
function initPanel() {
  // 创建 Shadow DOM 容器并挂载到 body
  const container = document.createElement('div');
  container.id = 'moekoe-comment-root';
  panelRoot = container.attachShadow({ mode: 'closed' });

  // ===== 注入面板样式 =====
  const style = document.createElement('style');
  style.textContent = `
    /* MoeKoeMusic 主题系统 - 暗色主题（默认） */
    .theme-dark {
      --bg: #1d1d1d;
      --bg-card: #2a2a2a;
      --text: #e1e1e1;
      --text-secondary: #999999;
      --text-tertiary: #777777;
      --border: #333333;
      --hover: #2a2a2a;
      --shadow: 0 8px 16px rgba(0,0,0,0.4);
      --overlay: rgba(0,0,0,0.7);
      --close: #ffffff;
      --close-hover: #dddddd;
      --btn-hover: rgba(255,255,255,0.08);
      --reply-bg: #252525;
      --scrollbar-track: #2a2a2a;
      --scrollbar-thumb: #4a4a4a;
      --scrollbar-thumb-hover: #666666;
      --spinner-border: #444444;
      --spinner-top: #e74c3c;
      --accent: #e74c3c;
      --accent-hover: #c0392b;
      --panel-radius: 5px;
      --item-radius: 4px;
      --avatar-bg: #2a2a2a;
    }

    /* MoeKoeMusic 主题系统 - 亮色主题 */
    .theme-light {
      --bg: #ffffff;
      --bg-card: #f5f5f5;
      --text: #333333;
      --text-secondary: #666666;
      --text-tertiary: #999999;
      --border: #e0e0e0;
      --hover: #f5f5f5;
      --shadow: 0 2px 12px rgba(0,0,0,0.1);
      --overlay: rgba(0,0,0,0.5);
      --close: #333333;
      --close-hover: #000000;
      --btn-hover: rgba(0,0,0,0.06);
      --reply-bg: #f9f9f9;
      --scrollbar-track: #f0f0f0;
      --scrollbar-thumb: #cccccc;
      --scrollbar-thumb-hover: #aaaaaa;
      --spinner-border: #e0e0e0;
      --spinner-top: #e74c3c;
      --accent: #e74c3c;
      --accent-hover: #c0392b;
      --panel-radius: 5px;
      --item-radius: 4px;
      --avatar-bg: #e0e0e0;
    }

    /* 遮罩层 */
    #overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: var(--overlay);
      z-index: 2147483646;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
    }
    #overlay.show {
      opacity: 1;
      pointer-events: auto;
    }

    /* 右侧滑面板 */
    #panel {
      position: fixed;
      top: 0;
      right: 0;
      width: 380px;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      z-index: 2147483647;
      transform: translateX(100%);
      transition: transform 0.3s ease;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow);
      border-radius: var(--panel-radius) 0 0 var(--panel-radius);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      box-sizing: border-box;
    }
    #panel.show {
      transform: translateX(0);
    }

    /* 面板头部 */
    #panel-header {
      display: flex;
      align-items: center;
      padding: 16px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      min-height: 52px;
      box-sizing: border-box;
    }
    #panel-title {
      font-size: 16px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      line-height: 1.4;
    }
    #panel-close {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: var(--close);
      border-radius: var(--item-radius);
      flex-shrink: 0;
      margin-left: 8px;
      padding: 0;
      line-height: 1;
      transition: background 0.2s, color 0.2s;
    }
    #panel-close:hover {
      background: var(--btn-hover);
      color: var(--close-hover);
    }

    /* 评论列表容器 */
    #comment-list {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    #comment-list::-webkit-scrollbar {
      width: 10px;
    }
    #comment-list::-webkit-scrollbar-track {
      background: var(--scrollbar-track);
      border: 2px solid transparent;
      background-clip: content-box;
    }
    #comment-list::-webkit-scrollbar-thumb {
      background: var(--scrollbar-thumb);
      border-radius: 5px;
      border: 2px solid transparent;
      background-clip: content-box;
      min-height: 40px;
      transition: background 0.2s;
    }
    #comment-list::-webkit-scrollbar-thumb:hover {
      background: var(--scrollbar-thumb-hover);
      border: 2px solid transparent;
      background-clip: content-box;
    }

    /* 加载状态 */
    #pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px 16px;
      flex-shrink: 0;
    }
    #load-status {
      font-size: 12px;
      color: var(--text-secondary);
    }

    /* 评论列表项 */
    .comment-item {
      display: block;
      overflow: hidden;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
      border-radius: var(--item-radius);
      transition: background 0.15s;
    }
    .comment-item:hover {
      background: var(--hover);
    }
    .comment-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      float: left;
      object-fit: cover;
      background: var(--avatar-bg);
    }
    .comment-body {
      margin-left: 48px;
    }
    .comment-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .comment-username {
      font-weight: 600;
      font-size: 13px;
      color: var(--text);
    }
    .comment-time {
      font-size: 12px;
      color: var(--text-secondary);
    }
    .comment-like {
      font-size: 12px;
      color: var(--text-secondary);
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      opacity: 0.7;
    }
    .comment-like::before {
      content: '';
      display: inline-block;
      width: 14px;
      height: 14px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z'/%3E%3Cpath d='M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3'/%3E%3C/svg%3E");
      background-size: contain;
      background-repeat: no-repeat;
      flex-shrink: 0;
    }
    .comment-content {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      word-break: break-word;
      white-space: pre-wrap;
      color: var(--text);
    }

    /* 状态提示 */
    .comment-status {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 16px;
      color: var(--text-secondary);
      font-size: 14px;
      text-align: center;
    }
    .comment-status.error {
      color: var(--accent);
    }
    .comment-status button {
      margin-top: 12px;
      padding: 6px 16px;
      border: 1px solid currentColor;
      background: transparent;
      border-radius: var(--item-radius);
      cursor: pointer;
      color: inherit;
      font-size: 13px;
      transition: background 0.2s;
    }
    .comment-status button:hover {
      background: var(--btn-hover);
    }

    /* 加载旋转动画 */
    @keyframes comment-spin {
      to { transform: rotate(360deg); }
    }
    .comment-status.loading::before {
      content: '';
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 3px solid var(--spinner-border);
      border-top-color: var(--spinner-top);
      border-radius: 50%;
      animation: comment-spin 0.8s linear infinite;
      margin-bottom: 8px;
    }

    /* 楼层回复 */
    .reply-toggle {
      display: block;
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 13px;
      padding: 8px 0 4px 0;
      font-family: inherit;
      margin-left: 48px;
      transition: color 0.2s;
    }
    .reply-toggle:hover {
      color: var(--accent-hover);
    }
    .reply-container {
      margin-left: 48px;
      padding: 8px 12px;
      background: var(--reply-bg);
      border-radius: 6px;
      margin-top: 4px;
      margin-bottom: 4px;
    }
    .reply-loading {
      color: var(--text-secondary);
      font-size: 13px;
      padding: 8px 0;
    }
    .reply-item {
      padding: 6px 0;
      font-size: 13px;
      line-height: 1.5;
      border-bottom: 1px solid var(--border);
    }
    .reply-item:last-child {
      border-bottom: none;
    }
    .reply-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .reply-user {
      font-weight: 600;
      color: var(--text);
    }
    .reply-content {
      color: var(--text);
      margin-top: 2px;
    }
    .reply-time {
      color: var(--text-secondary);
      font-size: 12px;
    }
    .reply-error {
      color: var(--accent);
    }
    .reply-retry-btn {
      margin-top: 4px;
      padding: 4px 12px;
      border: 1px solid var(--accent);
      background: none;
      color: var(--accent);
      border-radius: var(--item-radius);
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s;
    }
    .reply-retry-btn:hover {
      background: var(--btn-hover);
    }

  `;
  // ===== 主题系统 =====
  // 创建 wrapper div 用于主题 class
  const panelWrapper = document.createElement('div');
  panelWrapper.id = 'panel-wrapper';

  // 检测主题
  function detectTheme() {
    return document.documentElement.classList.contains('dark');
  }

  function applyTheme(isDark) {
    panelWrapper.classList.toggle('theme-dark', isDark);
    panelWrapper.classList.toggle('theme-light', !isDark);
  }

  // 初始应用主题
  applyTheme(detectTheme());

  // 监听 html 的 class 变化
  const themeObserver = new MutationObserver(function() {
    applyTheme(detectTheme());
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // ===== 构建面板 HTML 结构 =====


  // 遮罩层
  const overlay = document.createElement('div');
  overlay.id = 'overlay';

  // 面板主体
  const panel = document.createElement('div');
  panel.id = 'panel';

  // 头部：歌曲名 + 关闭按钮
  const header = document.createElement('div');
  header.id = 'panel-header';

  const title = document.createElement('span');
  title.id = 'panel-title';
  title.textContent = '评论';

  const closeBtn = document.createElement('button');
  closeBtn.id = 'panel-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.setAttribute('aria-label', '关闭');

  header.appendChild(title);
  header.appendChild(closeBtn);

  // 评论列表容器
  const commentList = document.createElement('div');
  commentList.id = 'comment-list';

  // 加载状态指示
  const pagination = document.createElement('div');
  pagination.id = 'pagination';
  const loadStatus = document.createElement('span');
  loadStatus.id = 'load-status';
  pagination.appendChild(loadStatus);
  let isLoadingMore = false;
  let hasMore = true;

  // 组装面板

  // 组装面板
  panel.appendChild(header);
  panel.appendChild(commentList);
  panel.appendChild(pagination);

  // 注入 Shadow DOM
  panelRoot.appendChild(style);
  panelWrapper.appendChild(overlay);
  panelWrapper.appendChild(panel);
  panelRoot.appendChild(panelWrapper);

  // 挂载容器到 body
  document.body.appendChild(container);

  // ===== 事件绑定 =====

  // 关闭按钮
  closeBtn.addEventListener('click', closePanel);

  // 遮罩点击关闭
  overlay.addEventListener('click', closePanel);

  // 阻止面板内部点击冒泡到遮罩
  panel.addEventListener('click', function (e) { e.stopPropagation(); });

  // Escape 键关闭
  document.addEventListener('keydown', function onKeyDown(e) {
    if (e.key === 'Escape' && isPanelOpen()) {
      closePanel();
    }
  });

  // ===== 无限滚动加载 =====

  async function loadNextPage() {
    if (isLoadingMore || !hasMore) return;
    isLoadingMore = true;
    loadStatus.textContent = '加载中...';
    currentPage++;
    await loadCommentsForPanel(true);
    isLoadingMore = false;
    if (hasMore) {
      loadStatus.textContent = '';
      if (commentList.scrollHeight <= commentList.clientHeight + 50) {
        commentList.dispatchEvent(new Event('scroll'));
      }
    } else {
      loadStatus.textContent = '已加载全部';
    }
  }

  commentList.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = commentList;
    if (scrollTop + clientHeight >= scrollHeight - 200) {
      loadNextPage();
    }
  });

  // ===== 面板接口方法 =====

  let currentPage = 1;
  let currentMixsongid = null;
  let currentSongHash = null;

  /**
   * 判断面板当前是否打开
   * @returns {boolean}
   */
  function isPanelOpen() {
    return overlay.classList.contains('show');
  }

  /**
   * 打开面板并显示歌曲评论
   * @param {string} [songName] - 歌曲名称
   */
  async function openPanel(songName) {
    title.textContent = songName || '评论';
    overlay.classList.add('show');
    panel.classList.add('show');
    const total = await loadCommentsForPanel();
    // 用 /comment/music 返回的 count 更新标题
    if (typeof total === 'number' && total > 0) {
      const displayCount = total > 999 ? '999+' : String(total);
      title.textContent = (songName || '评论') + '（' + displayCount + '）';
    }
    // 初始加载后未填满视口则自动补页
    if (hasMore && commentList.scrollHeight <= commentList.clientHeight + 50) {
      loadNextPage();
    }
  }

  /** 关闭面板 */
  function closePanel() {
    overlay.classList.remove('show');
    panel.classList.remove('show');
  }

  /**
   * 切换面板打开/关闭状态
   * @param {string} [songName] - 歌曲名称
   */
  function togglePanel(songName) {
    if (isPanelOpen()) {
      closePanel();
    } else {
      openPanel(songName);
    }
  }

  // ===== 时间格式 =====

  function formatCommentTime(timestamp) {
    const now = Date.now();
    const time = typeof timestamp === 'number' && timestamp > 1e12 ? timestamp : timestamp * 1000;
    const diff = now - time;

    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';

    const date = new Date(time);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  // ===== 状态渲染函数 =====

  function showLoadingState() {
    commentList.textContent = '';
    const status = document.createElement('div');
    status.className = 'comment-status loading';
    status.textContent = '加载中...';
    commentList.appendChild(status);
  }

  function showEmptyState() {
    commentList.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'comment-status';
    empty.textContent = '暂无评论，快来抢沙发！';
    commentList.appendChild(empty);
  }

  function showErrorState(message) {
    commentList.textContent = '';
    const error = document.createElement('div');
    error.className = 'comment-status error';

    const msg = document.createElement('p');
    msg.textContent = message || '加载失败';

    const retryBtn = document.createElement('button');
    retryBtn.textContent = '点击重试';
    retryBtn.addEventListener('click', async () => {
      await loadCommentsForPanel();
    });

    error.appendChild(msg);
    error.appendChild(retryBtn);
    commentList.appendChild(error);
  }

  // ===== 评论渲染函数 =====

  function renderCommentItem(comment) {
    const item = document.createElement('div');
    item.className = 'comment-item';

    const img = document.createElement('img');
    img.className = 'comment-avatar';
    const avatarUrl = comment.user_pic || comment.avatar || comment.avatar_url || comment.user_avatar || '';
    img.src = avatarUrl || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><rect width="36" height="36" rx="18" fill="#e0e0e0"/><text x="18" y="22" text-anchor="middle" fill="#999" font-size="14">?</text></svg>');
    img.alt = '';
    img.loading = 'lazy';

    const body = document.createElement('div');
    body.className = 'comment-body';

    const meta = document.createElement('div');
    meta.className = 'comment-meta';

    const username = document.createElement('span');
    username.className = 'comment-username';
    username.textContent = getCommentAuthorName(comment) || '匿名';

    const time = document.createElement('span');
    time.className = 'comment-time';
    let commentTime = comment.addtime || comment.time || comment.timestamp || comment.create_time || comment.date || 0;
    // 处理日期字符串格式（如 "2024-10-27 22:59:03"）
    if (typeof commentTime === 'string' && /^\d{4}-\d{2}-\d{2}/.test(commentTime)) {
      commentTime = new Date(commentTime.replace(' ', 'T') + '+08:00').getTime();
    }
    time.textContent = formatCommentTime(commentTime);

    meta.appendChild(username);

    meta.appendChild(time);

    // 点赞数
    const likeCount = comment.like?.count || 0;
    if (likeCount > 0) {
      const likeEl = document.createElement('span');
      likeEl.className = 'comment-like';
      likeEl.textContent = likeCount;
      meta.appendChild(likeEl);
    }

    const contentEl = document.createElement('p');
    contentEl.className = 'comment-content';
    const rawContent = comment.content || comment.message || comment.text || '';
    contentEl.textContent = rawContent;

    body.appendChild(meta);
    body.appendChild(contentEl);
    item.appendChild(img);
    item.appendChild(body);

    // 回复展开/折叠（仅?reply_num > 0 时显示）
    if (comment.reply_num > 0) {
      const replyToggle = document.createElement('button');
      replyToggle.className = 'reply-toggle';
      replyToggle.textContent = '查看全部 ' + comment.reply_num + ' 条回复';

      const replyContainer = document.createElement('div');
      replyContainer.className = 'reply-container';
      replyContainer.style.display = 'none';

      item.appendChild(replyToggle);
      item.appendChild(replyContainer);

      replyToggle.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (replyContainer.style.display === 'none') {
          await loadReplies(comment, replyContainer, replyToggle);
        } else {
          replyContainer.style.display = 'none';
      replyToggle.textContent = '查看全部 ' + comment.reply_num + ' 条回复';
        }
      });
    }

    return item;
  }

  /**
   * 加载并渲染楼层回
   * @param {Object} parentComment - 父评论对
   * @param {HTMLElement} container - 回复容器元素
   * @param {HTMLElement} toggleBtn - 展开/折叠按钮
   */
  async function loadReplies(parentComment, container, toggleBtn) {
    // 显示加载状
    container.textContent = '';
    container.style.display = 'block';
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'reply-loading';
    loadingDiv.textContent = '加载中...';
    container.appendChild(loadingDiv);
    toggleBtn.textContent = '加载中...';

    try {
      const API_BASE = 'http://127.0.0.1:6521';
      const signal = currentCommentAbortController ? currentCommentAbortController.signal : null;

      // 构建 URL: 需?special_id + tid + mixsongid
      const specialId = parentComment.special_child_id || parentComment.special_id;
      const tid = parentComment.id;
      const mixsongid = currentMixsongid;

      if (!specialId || !tid || !mixsongid) {
        container.textContent = '无法加载回复';
        toggleBtn.textContent = '加载失败，点击重试';
        return;
      }

      const url = API_BASE + '/comment/floor?special_id=' + encodeURIComponent(specialId) +
                  '&tid=' + encodeURIComponent(tid) +
                  '&mixsongid=' + encodeURIComponent(mixsongid);

      const headers = getAuthHeaders();
      const response = await fetch(url, { headers, signal });

      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }

      const data = await response.json();

      // 解析回复列表：兼容多种响应格
      let replies = [];
      if (data && Array.isArray(data.list)) {
        replies = data.list;
      } else if (Array.isArray(data)) {
        replies = data;
      } else if (data && Array.isArray(data.replies)) {
        replies = data.replies;
      } else if (data && Array.isArray(data.data)) {
        replies = data.data;
      } else if (data && data.data && Array.isArray(data.data.replies)) {
        replies = data.data.replies;
      } else if (data && Array.isArray(data.comments)) {
        replies = data.comments;
      }

      container.textContent = '';
      toggleBtn.textContent = '收起回复';

      if (replies.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'reply-item';
        empty.textContent = '暂无回复';
        container.appendChild(empty);
        return;
      }

      // 使用 DocumentFragment 批量渲染
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < replies.length; i++) {
        fragment.appendChild(renderReplyItem(replies[i], parentComment));
      }
      container.appendChild(fragment);

    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error('[MoeKoeMusic Comment] 加载回复失败:', e.message);
      container.textContent = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'reply-item reply-error';
      errorDiv.textContent = '加载失败';

      const retryBtn = document.createElement('button');
      retryBtn.textContent = '点击重试';
      retryBtn.className = 'reply-retry-btn';
      retryBtn.addEventListener('click', async () => {
        await loadReplies(parentComment, container, toggleBtn);
      });

      container.appendChild(errorDiv);
      container.appendChild(retryBtn);
      toggleBtn.textContent = '加载失败，点击重试';
    }
  }

  function renderReplyItem(reply, parentComment) {
    const item = document.createElement('div');
    item.className = 'reply-item';

    // 头部：用户名 + 时间
    const header = document.createElement('div');
    header.className = 'reply-header';

    const replyUser = document.createElement('span');
    replyUser.className = 'reply-user';
    replyUser.textContent = getCommentAuthorName(reply) || '匿名';

    const replyTime = document.createElement('span');
    replyTime.className = 'reply-time';
    let replyTimeVal = reply.addtime || reply.time || reply.timestamp || reply.create_time;
    if (typeof replyTimeVal === 'string' && /^\d{4}-\d{2}-\d{2}/.test(replyTimeVal)) {
      replyTimeVal = new Date(replyTimeVal.replace(' ', 'T') + '+08:00').getTime();
    }
    if (replyTimeVal) {
      replyTime.textContent = formatCommentTime(replyTimeVal);
    }

    header.appendChild(replyUser);
    header.appendChild(replyTime);

    // 回复内容（单独一行）
    const replyContent = document.createElement('div');
    replyContent.className = 'reply-content';
    const rawReply = reply.content || reply.message || reply.text || '';
    replyContent.textContent = stripQuotedReplyToParent(rawReply, reply, parentComment);

    item.appendChild(header);
    item.appendChild(replyContent);
    return item;
  }

  function renderComments(comments, page, total, pagesize) {
    commentList.textContent = '';

    if (!comments || comments.length === 0) {
      showEmptyState();
      updatePagination(page, total, pagesize);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < comments.length; i++) {
      fragment.appendChild(renderCommentItem(comments[i]));
    }
    commentList.appendChild(fragment);
    updatePagination(page, total, pagesize);
  }

  function updatePagination(page, total, pagesize) {
    hasMore = page * pagesize < total;
  }

  // ===== 数据加载 =====

  async function loadCommentsForPanel(append = false) {
    const song = getCurrentSong();
    const hash = song && song.hash ? song.hash : null;

    if (!hash) {
      showEmptyState();
      updatePagination(0, 0, 20);
      return;
    }

    // 如果歌曲变了，重置到第1页
    if (hash !== currentSongHash) {
      currentSongHash = hash;
      currentPage = 1;
      currentMixsongid = null;
    }

    // 检查评论列表缓存
    const cacheKey = `${currentMixsongid || hash}_${currentPage}`;
    const cachedList = getFromCache(cacheKey, commentListCache);
    if (cachedList) {
      if (cachedList.comments && cachedList.comments.length > 0) {
        if (append) {
          const fragment = document.createDocumentFragment();
          for (const c of cachedList.comments) {
            fragment.appendChild(renderCommentItem(c));
          }
          commentList.appendChild(fragment);
        } else {
          renderComments(cachedList.comments, cachedList.page, cachedList.total, cachedList.pagesize);
        }
      } else {
        if (!append) showEmptyState();
      }
      updatePagination(cachedList.page, cachedList.total, cachedList.pagesize);
      return cachedList.total;
    }

    if (!append) showLoadingState();

    // 获取 mixsongid
    const signal = currentCommentAbortController ? currentCommentAbortController.signal : null;
    let mixsongid = currentMixsongid;
    if (!mixsongid) {
      mixsongid = await resolveMixSongId(hash, signal);
    }
    if (!mixsongid) {
      showErrorState('无法获取评论数据');
      updatePagination(0, 0, 20);
      return 0;
    }
    currentMixsongid = mixsongid;

    // 获取评论
    const result = await fetchComments(mixsongid, currentPage, 30, signal);

    // 写入缓存（使用 mixsongid_page 作为键）
    const newCacheKey = `${mixsongid}_${currentPage}`;
    setToCache(newCacheKey, result, commentListCache);

    if (!result.comments || result.comments.length === 0) {
      if (!append) showEmptyState();
      hasMore = false;
    } else {
      if (append) {
        const fragment = document.createDocumentFragment();
        for (const c of result.comments) {
          fragment.appendChild(renderCommentItem(c));
        }
        commentList.appendChild(fragment);
      } else {
        renderComments(result.comments, result.page, result.total, result.pagesize);
        // 初始加载后若未填满视口，自动触发追加
        if (commentList.scrollHeight <= commentList.clientHeight + 50) {
          loadNextPage();
        }
      }
    }
    updatePagination(result.page, result.total, result.pagesize);
    return result.total;
  }

  // ===== 初始化 =====

  // 导出到全局，供外部调用
  window.__commentPanel = {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
  };

  console.log('[MoeKoeMusic Comment] ✅ 评论面板 Shadow DOM 已就绪');
}

// ====== 歌词页面评论入口 ======

/** 歌词页面按钮 DOM 引用 */
let lyricsBtn = null;
/** 歌词页面检测观察器 */
let lyricsObserver = null;

/**
   * 初始化歌词页面评论入口
   * 监听 hash 路由变化，检测 /lyrics 页面并注入评论按钮
 */
function initLyricsEntry() {
  // 立即检测当前路
  checkLyricsRoute();

  // 监听 hash 变化
  window.addEventListener('hashchange', () => {
    checkLyricsRoute();
  });
}

/**
 * 检测当前路由是否为歌词页面，是则注入评论按钮，否则清理
 */
function checkLyricsRoute() {
  const hash = location.hash || '';

  if (hash.includes('/lyrics') || hash.includes('/Lyrics')) {
    // 歌词页面：等待 DOM 渲染后注入按钮
    waitForLyricsContainer();
  } else {
    // 非歌词页面：清理已注入的按钮
    cleanupLyricsEntry();
  }
}

/**
 * 等待歌词页面 DOM 渲染完成，然后注入评论按
 */
function waitForLyricsContainer() {
  // 如果按钮已存在，无需重复创建
  if (lyricsBtn && document.contains(lyricsBtn)) return;

  // 歌词页面可能的注入点选择器列表（按优先级排列）
  const selectors = [
    '.lyrics-controls',
    '.lyrics-page .controls',
    '.lyrics-container .controls',
    '.player-controls',
    '.lyrics-header',
  ];

  // 尝试直接查找
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      injectLyricsButton(el);
      return;
    }
  }

  // 如果未找到，使用 MutationObserver 等待
  if (lyricsObserver) lyricsObserver.disconnect();

  lyricsObserver = new MutationObserver((mutations, obs) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        obs.disconnect();
        lyricsObserver = null;
        injectLyricsButton(el);
        return;
      }
    }
  });

  lyricsObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * 在歌词页面的指定容器中注入评论按
 * @param {HTMLElement} container - 注入目标容器
 */
function injectLyricsButton(container) {
  // 避免重复注入
  if (lyricsBtn && document.contains(lyricsBtn)) return;
  // 清理旧引用
  cleanupLyricsEntry();

  const btn = document.createElement('button');
  btn.id = 'moekoe-lyrics-comment-btn';
  btn.className = 'extra-btn';
  btn.title = '查看评论';
  btn.style.cssText = 'background: none; border: none; font-size: 16px; cursor: pointer; padding: 0 8px; color: #777;';

  // 评论图标
  btn.appendChild(createCommentIcon());
  container.appendChild(btn);

  lyricsBtn = btn;

  // 点击事件：使用与底部条相同的面板实例
  btn.addEventListener('click', () => {
    const song = getCurrentSong();
    const songName = song && song.name ? song.name : '评论';
    if (window.__commentPanel) {
      window.__commentPanel.toggle(songName);
    }
  });

  console.log('[MoeKoeMusic Comment] 歌词页面评论入口已注入');
}

/**
 * 清理歌词页面注入的按钮和观察
 */
function cleanupLyricsEntry() {
  if (lyricsBtn && lyricsBtn.parentNode) {
    lyricsBtn.parentNode.removeChild(lyricsBtn);
  }
  lyricsBtn = null;

  if (lyricsObserver) {
    lyricsObserver.disconnect();
    lyricsObserver = null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  console.log('[MoeKoeMusic Comment] DOMContentLoaded 触发，document.readyState=' + document.readyState);
  console.log('[MoeKoeMusic Comment] DOM 就绪，等待歌曲状态...');

  // 初始化入
  function init() {
    console.log('[MoeKoeMusic Comment] init() 被调用，document.readyState=' + document.readyState);
    console.log('[MoeKoeMusic Comment] 开始初始化：initBadge() + initPanel() + initLyricsEntry()');
    initBadge();
    initPanel();
    initLyricsEntry();
    console.log('[MoeKoeMusic Comment] ✅ 初始化完成');
  }

  // 延迟初始化，确保页面完全加载
  setTimeout(init, 1000);
});

// 额外兜底：如?DOMContentLoaded 已过，直接初始化
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  console.log('[MoeKoeMusic Comment] DOMContentLoaded 可能已过，直接初始化 (readyState=' + document.readyState + ')');
  setTimeout(() => {
    console.log('[MoeKoeMusic Comment] 兜底初始化开始，document.readyState=' + document.readyState);
    initBadge();
    initPanel();
    initLyricsEntry();
    console.log('[MoeKoeMusic Comment] ✅ 兜底初始化完成');
  }, 1000);
}

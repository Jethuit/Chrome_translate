(() => {
  const previousCleanup = window.__xttCleanup;
  if (typeof previousCleanup === 'function') {
    try {
      previousCleanup();
    } catch (error) {
      console.warn('X Tweet Translator: 清理旧实例失败', error);
    }
  }

  const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
  const TRANSLATABLE_SELECTOR = TWEET_TEXT_SELECTOR;
  const EXTENSION_UI_SELECTOR = '.xtt-block, .xtt-loading, .xtt-error';
  const SCAN_ROOT_SELECTOR = 'main[role="main"], [role="dialog"], [aria-modal="true"]';
  const MIN_TEXT_LENGTH = 4;
  const PAGE_CACHE_MAX_SIZE = 300;
  const MAX_CONSECUTIVE_ERRORS = 3;
  const SHOW_MORE_LABELS = new Set([
    'show more',
    '显示更多',
    '顯示更多',
    '查看更多',
    '展开',
    '展開',
    'さらに表示',
    'もっと見る',
    '더 보기',
    '더보기'
  ]);

  let settings = {
    autoJapanese: true,
    autoEnglish: false,
    autoAll: false,
    hotkey: 'Alt',
    targetLang: '中文',
    enabled: true,
    autoTranslateLimit: 3,
    baseUrl: '',
    modelId: ''
  };

  let hotkeyPressed = false;
  let hoverTimer = null;
  let currentHoverEl = null;
  let translatedElements = new WeakSet();
  let translatedElementTexts = new WeakMap();
  let translatingElements = new WeakSet();
  let elementRetryCounts = new WeakMap();
  const translatedTextCache = new Map();
  let consecutiveErrors = 0;
  let autoTranslatePaused = false;
  let contextInvalidated = false;
  let mutationDebounceTimer = null;
  let mutationObserver = null;
  let mutationScanRunning = false;
  let mutationScanQueued = false;

  function isContextValid() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function cleanupUi() {
    document.querySelectorAll(EXTENSION_UI_SELECTOR).forEach((el) => el.remove());
  }

  function getTextCacheKey(text) {
    return `${settings.targetLang}::${text.trim().replace(/\s+/g, ' ')}`;
  }

  function getCachedPageTranslation(text) {
    return translatedTextCache.get(getTextCacheKey(text)) || null;
  }

  function cachePageTranslation(text, translated) {
    const cacheKey = getTextCacheKey(text);
    translatedTextCache.delete(cacheKey);
    translatedTextCache.set(cacheKey, translated);

    while (translatedTextCache.size > PAGE_CACHE_MAX_SIZE) {
      const oldestKey = translatedTextCache.keys().next().value;
      translatedTextCache.delete(oldestKey);
    }
  }

  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function cleanupHover() {
    clearHoverTimer();
    if (currentHoverEl) {
      currentHoverEl.classList.remove('xtt-hover');
      currentHoverEl = null;
    }
  }

  function resetTranslationState({ clearTextCache = false, clearUi = true } = {}) {
    translatedElements = new WeakSet();
    translatedElementTexts = new WeakMap();
    translatingElements = new WeakSet();
    elementRetryCounts = new WeakMap();
    consecutiveErrors = 0;
    autoTranslatePaused = false;

    if (clearTextCache) {
      translatedTextCache.clear();
    }

    if (clearUi) {
      cleanupUi();
    }

    cleanupHover();
  }

  async function loadSettings() {
    const result = await chrome.storage.sync.get(settings);
    Object.assign(settings, result);
  }

  function shouldResetForSettings(nextSettings) {
    return settings.targetLang !== nextSettings.targetLang
      || settings.baseUrl !== nextSettings.baseUrl
      || settings.modelId !== nextSettings.modelId;
  }

  function handleRuntimeMessage(message) {
    if (message.type === 'SETTINGS_UPDATED') {
      const requiresReset = shouldResetForSettings(message.settings);

      Object.assign(settings, message.settings);
      contextInvalidated = false;

      // Always clear retry/pause state after settings change so failed items can retry.
      // Only clear rendered translations/text cache when the translation output can differ.
      resetTranslationState({
        clearTextCache: requiresReset,
        clearUi: requiresReset
      });

      void handleMutations();
    }

    if (message.type === 'TRANSLATE_PAGE') {
      consecutiveErrors = 0;
      autoTranslatePaused = false;
      void translatePage();
    }
  }

  const settingsReady = loadSettings().catch((error) => {
    console.error('X Tweet Translator: 加载设置失败', error);
  });

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  function detectLanguage(text) {
    const sample = text.slice(0, 300);
    const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
    const cjkRegex = /[\u4E00-\u9FFF]/;
    const koreanRegex = /[가-힯]/;
    const latinLetters = sample.match(/[a-zA-Z]/g);
    const totalChars = sample.replace(/\s/g, '').length;

    if (japaneseRegex.test(sample)) return 'ja';
    if (koreanRegex.test(sample)) return 'ko';
    if (cjkRegex.test(sample)) return 'zh';
    if (latinLetters && totalChars > 0 && latinLetters.length / totalChars > 0.6) return 'en';
    return 'other';
  }

  const TARGET_LANG_TO_CODE = {
    '中文': 'zh',
    'English': 'en',
    '日本語': 'ja',
    '한국어': 'ko'
  };

  function shouldAutoTranslate(lang) {
    if (settings.autoAll) {
      const targetCode = TARGET_LANG_TO_CODE[settings.targetLang] || '';
      return lang !== targetCode;
    }
    if (lang === 'ja' && settings.autoJapanese) return true;
    if (lang === 'en' && settings.autoEnglish) return true;
    return false;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function insertAfterElement(referenceEl, newEl) {
    referenceEl.insertAdjacentElement('afterend', newEl);
  }

  function createTranslationBlock(translatedText, referenceEl) {
    const block = document.createElement('div');
    block.className = 'xtt-block';
    block.textContent = translatedText;
    insertAfterElement(referenceEl, block);
    return block;
  }

  function createStreamingBlock(referenceEl) {
    const block = document.createElement('div');
    block.className = 'xtt-block xtt-streaming';
    block.textContent = '翻译中';
    insertAfterElement(referenceEl, block);
    return block;
  }

  function createTemporaryError(referenceEl, message) {
    const errBlock = document.createElement('div');
    errBlock.className = 'xtt-error';
    errBlock.textContent = message;
    insertAfterElement(referenceEl, errBlock);
    setTimeout(() => errBlock.remove(), 6000);
    return errBlock;
  }

  function translateTextStream(text, targetLang, onUpdate) {
    return new Promise((resolve, reject) => {
      let port;
      let lastText = '';
      let settled = false;

      function cleanup() {
        if (!port) return;

        try {
          port.onMessage.removeListener(handleMessage);
        } catch {
          // Listener may already be detached if the extension context changed.
        }

        try {
          port.onDisconnect.removeListener(handleDisconnect);
        } catch {
          // Listener may already be detached if the extension context changed.
        }

        try {
          port.disconnect();
        } catch {
          // Port may already be closed by the background worker.
        }
      }

      function settle(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }

      function handleMessage(message) {
        if (message.type === 'CHUNK') {
          const nextText = typeof message.translated === 'string'
            ? message.translated
            : `${lastText}${message.delta || ''}`;

          if (nextText) {
            lastText = nextText;
            onUpdate(lastText);
          }
          return;
        }

        if (message.type === 'DONE') {
          const finalText = (typeof message.translated === 'string'
            ? message.translated
            : lastText).trim();

          if (!finalText) {
            settle(reject, new Error('API返回空翻译结果'));
            return;
          }

          onUpdate(finalText);
          settle(resolve, finalText);
          return;
        }

        if (message.type === 'ERROR') {
          settle(reject, new Error(message.error || '流式翻译失败'));
        }
      }

      function handleDisconnect() {
        if (!settled) {
          settle(reject, new Error('流式翻译连接已断开'));
        }
      }

      try {
        port = chrome.runtime.connect({ name: 'TRANSLATE_STREAM' });
        port.onMessage.addListener(handleMessage);
        port.onDisconnect.addListener(handleDisconnect);
        port.postMessage({ type: 'START', text, targetLang });
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  function extractText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }
    if (node.tagName === 'IMG') {
      return node.getAttribute('alt') || '';
    }
    let out = '';
    for (const child of node.childNodes) {
      out += extractText(child);
    }
    return out;
  }

  function getElementText(el) {
    return extractText(el).trim();
  }

  function normalizeControlText(text) {
    return text
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.。…]+$/u, '')
      .toLowerCase();
  }

  function isShowMoreText(text) {
    return SHOW_MORE_LABELS.has(normalizeControlText(text));
  }

  function getCandidateControlText(el) {
    return el.getAttribute('aria-label') || el.textContent || '';
  }

  function getSafeClickableExpandControl(labelEl, tweetTextEl) {
    const clickable = labelEl.closest('button, [role="button"], a[href]');
    const target = clickable || labelEl;

    if (!tweetTextEl.contains(target)) {
      return null;
    }

    if (target.closest('a[href]') || target.getAttribute('role') === 'link') {
      return null;
    }

    if (target.matches('button, [role="button"]')) {
      return target;
    }

    return labelEl;
  }

  function findInlineShowMoreControl(tweetTextEl) {
    const candidates = tweetTextEl.querySelectorAll('button, [role="button"], a[href], span, div');
    let sawUnsafeLabel = false;

    for (const candidate of candidates) {
      if (!isVisibleElement(candidate)) {
        continue;
      }

      if (!isShowMoreText(getCandidateControlText(candidate))) {
        continue;
      }

      const safeControl = getSafeClickableExpandControl(candidate, tweetTextEl);
      if (safeControl) {
        return {
          status: 'safe',
          control: safeControl
        };
      }

      sawUnsafeLabel = true;
    }

    return {
      status: sawUnsafeLabel ? 'unsafe' : 'none',
      control: null
    };
  }

  function clickExpandControl(control) {
    control.scrollIntoView({
      block: 'nearest',
      inline: 'nearest'
    });

    for (const eventType of ['mousedown', 'mouseup', 'click']) {
      control.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    }
  }

  function getLatestTweetTextElement(article, fallbackEl) {
    if (article?.isConnected) {
      return article.querySelector(TWEET_TEXT_SELECTOR) || fallbackEl;
    }

    return fallbackEl;
  }

  async function waitForTweetExpansion(article, originalEl, previousText) {
    const observeRoot = article || originalEl;

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let timeoutId = null;

      function finish(expanded) {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        const element = getLatestTweetTextElement(article, originalEl);
        resolve({ element, expanded });
      }

      function checkExpanded() {
        const element = getLatestTweetTextElement(article, originalEl);
        const currentText = getElementText(element);
        const showMoreState = findInlineShowMoreControl(element).status;

        if (currentText && (currentText !== previousText || showMoreState === 'none')) {
          finish(true);
        }
      }

      observer = new MutationObserver(checkExpanded);
      observer.observe(observeRoot, {
        childList: true,
        subtree: true,
        characterData: true
      });

      timeoutId = setTimeout(() => finish(false), 1800);
      queueMicrotask(checkExpanded);
    });
  }

  async function expandTweetTextIfNeeded(el) {
    const showMoreState = findInlineShowMoreControl(el);

    if (showMoreState.status === 'none') {
      return { element: el, blocked: false };
    }

    if (showMoreState.status === 'unsafe') {
      return {
        element: el,
        blocked: true,
        reason: '这条推文未完全展开，请先点开“显示更多”再翻译完整内容'
      };
    }

    const article = el.closest('article[data-testid="tweet"]');
    const previousText = getElementText(el);

    try {
      clickExpandControl(showMoreState.control);
    } catch {
      return {
        element: el,
        blocked: true,
        reason: '未能自动展开这条推文，请先点开“显示更多”再翻译完整内容'
      };
    }

    await delay(60);

    const result = await waitForTweetExpansion(article, el, previousText);
    const latestState = findInlineShowMoreControl(result.element);

    if (result.expanded || latestState.status === 'none') {
      return { element: result.element, blocked: false };
    }

    return {
      element: result.element,
      blocked: true,
      reason: '未能自动展开这条推文，请先点开“显示更多”再翻译完整内容'
    };
  }

  function isVisibleElement(el) {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function isExtensionUiElement(el) {
    return Boolean(el.closest(EXTENSION_UI_SELECTOR));
  }

  function hasTranslationBlockAfter(el) {
    const next = el.nextElementSibling;
    return Boolean(next && next.matches(EXTENSION_UI_SELECTOR));
  }

  function removeExtensionUiAfter(el) {
    const next = el.nextElementSibling;
    if (next && next.matches(EXTENSION_UI_SELECTOR)) {
      next.remove();
    }
  }

  function markElementTranslated(el, text) {
    translatedElements.add(el);
    translatedElementTexts.set(el, text);
  }

  function reconcileTranslatedElementText(el, text) {
    if (!translatedElements.has(el)) return;

    const previousText = translatedElementTexts.get(el);
    if (previousText === text) return;

    translatedElements.delete(el);
    translatedElementTexts.delete(el);
    removeExtensionUiAfter(el);
  }

  function tryRenderCachedTranslation(el) {
    const text = getElementText(el);
    reconcileTranslatedElementText(el, text);

    const cachedTranslation = getCachedPageTranslation(text);

    if (!cachedTranslation) return false;
    if (!text || text.length < MIN_TEXT_LENGTH) return false;
    if (translatingElements.has(el)) return false;
    if (isExtensionUiElement(el) || !isVisibleElement(el)) return false;
    if (hasTranslationBlockAfter(el)) return false;

    createTranslationBlock(cachedTranslation, el);
    markElementTranslated(el, text);
    return true;
  }

  function isTranslatableElement(el) {
    const text = getElementText(el);
    reconcileTranslatedElementText(el, text);

    if (!text || text.length < MIN_TEXT_LENGTH) return false;
    if (translatedElements.has(el) || translatingElements.has(el)) return false;
    if (isExtensionUiElement(el) || !isVisibleElement(el)) return false;
    if (hasTranslationBlockAfter(el)) return false;
    if (getCachedPageTranslation(text)) return false;

    const retries = elementRetryCounts.get(el) || 0;
    if (settings.autoTranslateLimit > 0 && retries >= settings.autoTranslateLimit) return false;

    return true;
  }

  function getScanRoots() {
    const roots = Array.from(document.querySelectorAll(SCAN_ROOT_SELECTOR))
      .filter((root) => root instanceof Element && isVisibleElement(root));

    return roots.length > 0 ? roots : [document.body].filter(Boolean);
  }

  async function translateElement(el) {
    if (translatingElements.has(el)) return;

    translatingElements.add(el);
    let activeEl = el;
    let streamBlock = null;

    try {
      if (!isContextValid()) {
        throw new Error('CONTEXT_INVALIDATED');
      }

      const expandResult = await expandTweetTextIfNeeded(activeEl);
      activeEl = expandResult.element || activeEl;

      if (activeEl !== el) {
        translatingElements.add(activeEl);
      }

      if (expandResult.blocked) {
        const retries = (elementRetryCounts.get(activeEl) || 0) + 1;
        elementRetryCounts.set(activeEl, retries);
        createTemporaryError(activeEl, expandResult.reason);
        return;
      }

      const text = getElementText(activeEl);
      if (!text || text.length < MIN_TEXT_LENGTH) return;

      const cachedTranslation = getCachedPageTranslation(text);
      if (cachedTranslation) {
        if (!hasTranslationBlockAfter(activeEl)) {
          createTranslationBlock(cachedTranslation, activeEl);
        }
        markElementTranslated(activeEl, text);
        return;
      }

      if (translatedElements.has(activeEl)) return;

      streamBlock = createStreamingBlock(activeEl);

      const translated = await translateTextStream(text, settings.targetLang, (partialText) => {
        streamBlock.textContent = partialText;
      });

      streamBlock.classList.remove('xtt-streaming');
      streamBlock.textContent = translated;
      cachePageTranslation(text, translated);
      markElementTranslated(activeEl, text);
      consecutiveErrors = 0;
    } catch (error) {
      streamBlock?.remove();

      if (error.message?.includes('Extension context invalidated') || error.message === 'CONTEXT_INVALIDATED') {
        contextInvalidated = true;
        autoTranslatePaused = true;
        console.warn('X Tweet Translator: 扩展已更新，正在重新连接');
        return;
      }

      const retries = (elementRetryCounts.get(activeEl) || 0) + 1;
      elementRetryCounts.set(activeEl, retries);
      consecutiveErrors++;

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        autoTranslatePaused = true;
      }

      createTemporaryError(activeEl, `翻译异常: ${error.message || '请检查插件配置'}`);
    } finally {
      translatingElements.delete(el);
      if (activeEl !== el) {
        translatingElements.delete(activeEl);
      }
    }
  }

  function getTranslatableElements() {
    const elements = [];
    const seen = new WeakSet();

    for (const root of getScanRoots()) {
      for (const el of root.querySelectorAll(TRANSLATABLE_SELECTOR)) {
        if (seen.has(el)) continue;
        seen.add(el);

        if (tryRenderCachedTranslation(el)) {
          continue;
        }

        if (isTranslatableElement(el)) {
          elements.push(el);
        }
      }
    }

    return elements;
  }

  async function translateElementsWithConcurrency(elements, concurrency = 3) {
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, elements.length);

    async function worker() {
      while (nextIndex < elements.length) {
        const el = elements[nextIndex];
        nextIndex++;
        await translateElement(el);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  async function translatePage() {
    await settingsReady;
    if (!settings.enabled || autoTranslatePaused || contextInvalidated) return;

    const elements = getTranslatableElements().filter((el) => {
      const lang = detectLanguage(getElementText(el));
      return shouldAutoTranslate(lang);
    });
    await translateElementsWithConcurrency(elements, 3);
  }

  async function handleMutations() {
    await settingsReady;

    if (mutationScanRunning) {
      mutationScanQueued = true;
      return;
    }

    mutationScanRunning = true;

    try {
      if (!settings.enabled || autoTranslatePaused || contextInvalidated) return;

      const elements = getTranslatableElements();
      if (elements.length === 0) return;

      const needTranslation = elements.filter((el) => {
        const text = getElementText(el);
        const lang = detectLanguage(text);
        return shouldAutoTranslate(lang);
      });

      if (needTranslation.length === 0) return;

      await translateElementsWithConcurrency(needTranslation, 3);
    } finally {
      mutationScanRunning = false;

      if (mutationScanQueued) {
        mutationScanQueued = false;
        void handleMutations();
      }
    }
  }

  function setupMutationObserver() {
    mutationObserver?.disconnect();

    mutationObserver = new MutationObserver(() => {
      if (mutationDebounceTimer) {
        clearTimeout(mutationDebounceTimer);
      }

      mutationDebounceTimer = setTimeout(() => {
        void handleMutations();
      }, 600);
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function getHotkeyState(e) {
    switch (settings.hotkey) {
      case 'Alt': return e.altKey;
      case 'Control': return e.ctrlKey;
      case 'Shift': return e.shiftKey;
      case 'Meta': return e.metaKey;
      default: return e.altKey;
    }
  }

  function isHoverTarget(el) {
    const text = getElementText(el);

    if (!text || text.length < MIN_TEXT_LENGTH) return false;
    if (translatingElements.has(el)) return false;
    if (isExtensionUiElement(el) || !isVisibleElement(el)) return false;

    return true;
  }

  function findTweetText(target) {
    if (!(target instanceof Element)) return null;
    if (isExtensionUiElement(target)) return null;

    const tweetEl = target.closest(TRANSLATABLE_SELECTOR);
    if (tweetEl && isHoverTarget(tweetEl)) return tweetEl;

    const article = target.closest('article[data-testid="tweet"]');
    if (article) {
      const textEl = article.querySelector(TWEET_TEXT_SELECTOR);
      if (textEl && isHoverTarget(textEl)) return textEl;
    }

    return null;
  }

  function handleMouseMove(e) {
    if (!settings.enabled || contextInvalidated) return;

    const isHotkeyActive = getHotkeyState(e);

    if (!isHotkeyActive) {
      if (hotkeyPressed) {
        hotkeyPressed = false;
        cleanupHover();
      }
      return;
    }

    if (!hotkeyPressed) {
      hotkeyPressed = true;
    }

    const target = findTweetText(e.target);
    if (target === currentHoverEl) return;

    if (currentHoverEl) {
      currentHoverEl.classList.remove('xtt-hover');
    }

    clearHoverTimer();
    currentHoverEl = target;

    if (!target) return;

    target.classList.add('xtt-hover');

    hoverTimer = setTimeout(() => {
      if (currentHoverEl === target) {
        void translateElement(target);
        target.classList.remove('xtt-hover');
        currentHoverEl = null;
      }
    }, 1000);
  }

  function handleWindowBlur() {
    hotkeyPressed = false;
    cleanupHover();
  }

  function cleanupInstance() {
    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }

    mutationObserver?.disconnect();
    mutationObserver = null;

    document.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('blur', handleWindowBlur);
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);

    resetTranslationState({ clearTextCache: true, clearUi: true });

    if (window.__xttCleanup === cleanupInstance) {
      delete window.__xttCleanup;
    }
  }

  window.__xttCleanup = cleanupInstance;
  cleanupUi();

  async function init() {
    await settingsReady;

    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => {
        void init();
      }, { once: true });
      return;
    }

    setupMutationObserver();
    document.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('blur', handleWindowBlur);

    setTimeout(() => {
      void handleMutations();
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void init();
    }, { once: true });
  } else {
    void init();
  }
})();

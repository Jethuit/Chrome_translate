const SUPPORTED_TAB_URLS = [
  'https://twitter.com/*',
  'https://x.com/*',
  'https://mobile.twitter.com/*',
  'https://discord.com/*',
  'https://canary.discord.com/*',
  'https://ptb.discord.com/*'
];

const CACHE_STORAGE_KEY = 'translationCacheV2';
const CACHE_MAX_SIZE = 500;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_PROMPT_VERSION = 'social-web-v3';

const translationCache = new Map();
const inFlightTranslations = new Map();

let cacheReadyPromise = null;
let cachePersistPromise = Promise.resolve();

chrome.runtime.onInstalled.addListener((details) => {
  void reinjectIntoExistingTabs(details.reason);
});

async function reinjectIntoExistingTabs(reason) {
  const tabs = await chrome.tabs.query({ url: SUPPORTED_TAB_URLS });

  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) return;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });

      try {
        await chrome.scripting.removeCSS({
          target: { tabId: tab.id },
          files: ['content.css']
        });
      } catch {
        // CSS may not have been injected yet, especially on newly supported sites.
      }

      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css']
      });
    } catch {
      // Tab may still be loading or otherwise unavailable.
    }
  }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE') {
    void (async () => {
      try {
        const translated = await handleTranslation(message.text, message.targetLang);
        sendResponse({ success: true, translated });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();

    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'TRANSLATE_STREAM') return;

  let portClosed = false;

  port.onDisconnect.addListener(() => {
    portClosed = true;
  });

  function postToPort(message) {
    if (portClosed) return;

    try {
      port.postMessage(message);
    } catch {
      portClosed = true;
    }
  }

  port.onMessage.addListener((message) => {
    if (message.type !== 'START') return;

    void (async () => {
      try {
        const translated = await handleTranslationStream(
          message.text,
          message.targetLang,
          async (delta, partialText) => {
            postToPort({
              type: 'CHUNK',
              delta,
              translated: partialText
            });
          }
        );

        postToPort({
          type: 'DONE',
          translated
        });
      } catch (error) {
        postToPort({
          type: 'ERROR',
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        try {
          port.disconnect();
        } catch {
          // Port may already be closed by the content script.
        }
      }
    })();
  });
});

async function ensureCacheLoaded() {
  if (!cacheReadyPromise) {
    cacheReadyPromise = chrome.storage.session.get(CACHE_STORAGE_KEY)
      .then((result) => {
        translationCache.clear();

        const entries = Array.isArray(result[CACHE_STORAGE_KEY])
          ? result[CACHE_STORAGE_KEY]
          : [];
        const now = Date.now();

        for (const entry of entries) {
          if (!entry || typeof entry.key !== 'string' || typeof entry.translated !== 'string') {
            continue;
          }

          if (typeof entry.timestamp !== 'number' || now - entry.timestamp > CACHE_TTL_MS) {
            continue;
          }

          translationCache.set(entry.key, {
            translated: entry.translated,
            timestamp: entry.timestamp
          });
        }
      })
      .catch(() => {
        translationCache.clear();
      });
  }

  await cacheReadyPromise;
}

async function persistCache() {
  const serializedCache = Array.from(translationCache.entries()).map(([key, value]) => ({
    key,
    translated: value.translated,
    timestamp: value.timestamp
  }));

  cachePersistPromise = cachePersistPromise
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({
      [CACHE_STORAGE_KEY]: serializedCache
    }));

  await cachePersistPromise;
}

function normalizeCacheText(text) {
  return text.trim().replace(/\s+/g, ' ');
}

function getCacheKey(text, targetLang, settings) {
  return [
    CACHE_PROMPT_VERSION,
    normalizeBaseUrl(settings.baseUrl || ''),
    settings.modelId || '',
    targetLang || '',
    normalizeCacheText(text)
  ].join('::');
}

async function getCachedTranslation(cacheKey) {
  await ensureCacheLoaded();

  const entry = translationCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    translationCache.delete(cacheKey);
    await persistCache();
    return null;
  }

  return entry.translated;
}

async function saveCachedTranslation(cacheKey, translated) {
  await ensureCacheLoaded();

  translationCache.delete(cacheKey);
  translationCache.set(cacheKey, {
    translated,
    timestamp: Date.now()
  });

  while (translationCache.size > CACHE_MAX_SIZE) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }

  await persistCache();
}

function normalizeBaseUrl(baseUrl) {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');

  if (!trimmedBaseUrl) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmedBaseUrl)) {
    return trimmedBaseUrl;
  }

  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(trimmedBaseUrl)) {
    return `http://${trimmedBaseUrl}`;
  }

  return `https://${trimmedBaseUrl}`;
}

function buildChatCompletionsUrl(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (normalizedBaseUrl.endsWith('/chat/completions')) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/chat/completions`;
}

async function handleTranslation(text, targetLang) {
  const settings = await chrome.storage.sync.get(['baseUrl', 'apiKey', 'modelId']);

  if (!settings.baseUrl || !settings.modelId) {
    throw new Error('请先在插件设置中配置 Base URL 和 Model ID');
  }

  const cacheKey = getCacheKey(text, targetLang, settings);
  const cachedTranslation = await getCachedTranslation(cacheKey);
  if (cachedTranslation) {
    return cachedTranslation;
  }

  const existingRequest = inFlightTranslations.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const requestPromise = requestTranslation(text, targetLang, settings)
    .then(async (translated) => {
      await saveCachedTranslation(cacheKey, translated);
      return translated;
    })
    .finally(() => {
      inFlightTranslations.delete(cacheKey);
    });

  inFlightTranslations.set(cacheKey, requestPromise);
  return requestPromise;
}

async function handleTranslationStream(text, targetLang, onDelta) {
  const settings = await chrome.storage.sync.get(['baseUrl', 'apiKey', 'modelId']);

  if (!settings.baseUrl || !settings.modelId) {
    throw new Error('请先在插件设置中配置 Base URL 和 Model ID');
  }

  const cacheKey = getCacheKey(text, targetLang, settings);
  const cachedTranslation = await getCachedTranslation(cacheKey);
  if (cachedTranslation) {
    return cachedTranslation;
  }

  const existingRequest = inFlightTranslations.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const requestPromise = requestTranslationStream(text, targetLang, settings, onDelta)
    .then(async (translated) => {
      await saveCachedTranslation(cacheKey, translated);
      return translated;
    })
    .finally(() => {
      inFlightTranslations.delete(cacheKey);
    });

  inFlightTranslations.set(cacheKey, requestPromise);
  return requestPromise;
}

function buildRequestHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  return headers;
}

function buildTranslationRequestBody(text, targetLang, settings, { stream = false } = {}) {
  const body = {
    model: settings.modelId,
    messages: [
      {
        role: 'system',
        content: `You are a professional ${targetLang} native translator specialized in social media and web chat content who needs to fluently translate text into ${targetLang}.

## Translation Rules
1. Output only the translated content, without explanations or additional content
2. Keep all hashtags in their original form, but translate the words within hashtags if appropriate
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. Preserve @mentions, cashtags, and URLs exactly as they appear in the original text
5. Maintain internet slang, abbreviations, and platform-specific terms with appropriate equivalents
6. Translate emojis contextually, preserving their intended meaning and sentiment
7. Preserve the concise nature and informal tone typical of social posts and chat messages`
      },
      {
        role: 'user',
        content: text
      }
    ],
    temperature: 0.3
  };

  if (stream) {
    body.stream = true;
  }

  return body;
}

function extractTranslationContent(data) {
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;

  if (typeof content !== 'string') {
    throw new Error('API返回格式错误');
  }

  const translated = content.trim();
  if (!translated) {
    throw new Error('API返回空翻译结果');
  }

  return translated;
}

function extractStreamDelta(data) {
  const delta = data?.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') {
    return delta;
  }

  const messageContent = data?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }

  const text = data?.choices?.[0]?.text;
  if (typeof text === 'string') {
    return text;
  }

  return '';
}

async function readStreamingResponse(response, onDelta) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let translated = '';

  async function processLine(rawLine) {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;

    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }

    const delta = extractStreamDelta(data);
    if (!delta) return;

    translated += delta;
    await onDelta(delta, translated);
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      await processLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      await processLine(line);
    }
  }

  const finalText = translated.trim();
  if (!finalText) {
    throw new Error('API返回空翻译结果');
  }

  return finalText;
}

async function requestTranslation(text, targetLang, settings) {
  const url = buildChatCompletionsUrl(settings.baseUrl);
  const headers = buildRequestHeaders(settings);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(buildTranslationRequestBody(text, targetLang, settings))
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API请求失败 (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    return extractTranslationContent(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('请求超时（30 秒），请检查网络或 LLM 服务可用性');
    }
    if (err instanceof TypeError) {
      throw new Error(`网络错误: ${err.message}。请检查 Base URL 是否正确`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestTranslationStream(text, targetLang, settings, onDelta) {
  const url = buildChatCompletionsUrl(settings.baseUrl);
  const headers = buildRequestHeaders(settings);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(buildTranslationRequestBody(text, targetLang, settings, { stream: true }))
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status < 500 && /stream/i.test(errorBody)) {
        return requestTranslation(text, targetLang, settings);
      }
      throw new Error(`API请求失败 (${response.status}): ${errorBody}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.body) {
      return requestTranslation(text, targetLang, settings);
    }

    if (contentType.includes('application/json')) {
      const data = await response.json();
      return extractTranslationContent(data);
    }

    return readStreamingResponse(response, onDelta);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('请求超时（30 秒），请检查网络或 LLM 服务可用性');
    }
    if (err instanceof TypeError) {
      throw new Error(`网络错误: ${err.message}。请检查 Base URL 是否正确`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

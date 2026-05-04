# 🔧 LLM Translate 技术文档

## 项目架构

```
├── manifest.json          # Chrome 扩展配置
├── background.js          # Service Worker（处理 API 调用）
├── content.js             # Content Script（页面操作）
├── popup.html/js/css      # 设置弹窗 UI
├── content.css            # 翻译样式
├── icons/                 # 扩展图标
└── README.md              # 完整文档
```

## 核心工作流

### 1. 页面加载时 (content.js)

```
页面加载 
  ↓
语言检测 (detectLanguage)
  ↓
判断是否需要自动翻译 (shouldAutoTranslate)
  ↓
获取可翻译的元素 (getTranslatableElements)
  ↓
逐个翻译 (translateElement)
```

### 2. 翻译请求流 (background.js + content.js)

```
content.js 发送: chrome.runtime.sendMessage({ type: 'TRANSLATE', text, targetLang })
    ↓
background.js 接收并处理
    ↓
调用 LLM API (fetch /chat/completions)
    ↓
返回翻译结果 sendResponse({ success: true, translated: result })
    ↓
content.js 显示翻译 (createTranslationBlock)
```

### 3. 快捷键 + 悬停翻译 (content.js)

```
document.addEventListener('keydown')
  ↓
检测是否按下配置的快捷键 (getHotkeyState)
  ↓
设置 hotkeyPressed = true
    ↓
document.addEventListener('mousemove')
  ↓
如果悬停超过 2 秒 (setTimeout 2000ms)
  ↓
调用 translateElement 翻译该段落
```

## 关键函数说明

### content.js 中的核心函数

#### `detectLanguage(text: string): string`
检测文本语言
- 返回值：'ja' (日文) | 'en' (英文) | 'other' (其他)
- 实现：正则表达式匹配 Unicode 范围

#### `shouldAutoTranslate(lang: string): boolean`
判断是否应该自动翻译
- 日文：始终自动翻译
- 英文：根据 settings.autoEnglish 判断
- 其他：不自动翻译

#### `translateElement(el: Element): Promise<void>`
翻译单个元素的主函数
- 1. 检查元素是否已翻译（translatedElements）
- 2. 显示"翻译中..."加载动画
- 3. 发送消息到 background.js 请求翻译
- 4. 显示翻译结果或错误信息

#### `getTranslatableElements(): Element[]`
获取页面中所有可翻译的元素
- 匹配选择器：p, h1-h6, li, td, th, blockquote, article, section, .post-content 等
- 过滤条件：
  - 文本长度 ≥ 3 个字符
  - 元素可见
  - 排除已翻译的元素
  - 排除嵌套过深的元素

### background.js 中的核心函数

#### `handleTranslation(text: string, targetLang: string): Promise<string>`
调用 LLM API 进行实际翻译
- 获取存储的 API 配置
- 验证 Base URL 格式（添加 https 协议）
- 构建 OpenAI 兼容的请求体
- 错误处理：验证响应格式，处理网络错误

#### 请求体格式
```json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "system",
      "content": "You are a professional translator. Translate the following text to 中文. Only output the translated text, without any explanation or extra content. Preserve the original formatting including line breaks and paragraphs."
    },
    {
      "role": "user",
      "content": "原文内容"
    }
  ],
  "temperature": 0.3
}
```

## 数据存储（chrome.storage.sync）

### 存储的设置

```javascript
{
  baseUrl: string,       // API 服务地址
  apiKey: string,        // API 密钥
  modelId: string,       // 模型 ID
  autoEnglish: boolean,  // 是否自动翻译英文
  hotkey: string,        // 快捷键（Alt/Ctrl/Shift/Meta）
  targetLang: string,    // 目标语言
  enabled: boolean       // 当前网站是否启用翻译
}
```

## API 集成指南

### OpenAI 格式 API 的必需字段

所有兼容 OpenAI 格式的 API 都应该支持：

```
POST {baseUrl}/chat/completions

Headers:
  Content-Type: application/json
  Authorization: Bearer {apiKey}

Response:
  {
    "choices": [{
      "message": {
        "content": "翻译结果"
      }
    }]
  }
```

### 测试 API 连接

在浏览器控制台测试：

```javascript
const settings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-...',
  modelId: 'gpt-4o'
};

const response = await fetch(`${settings.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${settings.apiKey}`
  },
  body: JSON.stringify({
    model: settings.modelId,
    messages: [{
      role: 'user',
      content: 'Hello'
    }],
    temperature: 0.3
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

## 扩展和定制

### 修改翻译的元素类型

在 content.js 的 `getTranslatableElements` 函数中修改 `selectors` 变量：

```javascript
const selectors = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, figcaption, dt, dd, caption, article, section, .post-content, .article-content, .your-custom-class';
```

### 修改检测语言的逻辑

编辑 `detectLanguage` 函数：

```javascript
function detectLanguage(text) {
  const sample = text.slice(0, 300);
  
  // 添加您自己的语言检测逻辑
  const customRegex = /[\uXXXX-\uXXXX]/; // 您的 Unicode 范围
  if (customRegex.test(sample)) return 'custom_lang';
  
  // 返回其他语言代码...
}
```

### 修改翻译系统提示词

在 background.js 的 `handleTranslation` 函数中修改 system message：

```javascript
{
  role: 'system',
  content: `You are a professional translator specialized in technical documents. 
           Translate to ${targetLang} while preserving all technical terms...`
}
```

### 调整温度参数

在 background.js 中修改 `temperature` 值：
- 0.0：最保守，输出最确定（推荐翻译）
- 0.7：平衡创意和准确性
- 1.0+：更有创意和变化（不推荐翻译）

## 样式自定义

### 翻译块的样式

编辑 content.css 中的 `.llm-translate-block` 类：

```css
.llm-translate-block {
  margin-top: 8px;
  padding: 10px 12px;
  background: linear-gradient(135deg, #f0f7ff 0%, #e8f2ff 100%);
  border-left: 4px solid #1a73e8;
  /* 修改这些属性自定义样式 */
}
```

### 加载动画颜色

修改 `.llm-translate-loading` 的 `color` 属性

## 调试技巧

### 1. 查看 console 日志

在 popup.js 或 content.js 中添加日志：

```javascript
console.log('检测到语言:', lang);
console.log('可翻译元素数量:', elements.length);
console.log('翻译结果:', result);
```

打开 DevTools (F12) → Console 查看

### 2. 检查存储的设置

在控制台中：

```javascript
// 查看所有存储的设置
chrome.storage.sync.get(null, (items) => {
  console.log('存储的设置:', items);
});
```

### 3. 检查 Service Worker 日志

在 `chrome://extensions/` 中点击插件的 "service worker" 链接查看日志

### 4. 测试翻译元素选择

在页面控制台运行：

```javascript
const selectors = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, figcaption, dt, dd, caption, article, section';
const elements = Array.from(document.querySelectorAll(selectors));
console.log('找到的可翻译元素:', elements);
console.log('元素数量:', elements.length);
```

## 性能优化建议

### 1. 批处理翻译

当前实现已使用批处理（每次 3 个）：
```javascript
const batchSize = 3;
for(let i = 0; i < elements.length; i += batchSize) {
  const batch = elements.slice(i, i + batchSize);
  await Promise.all(batch.map(el => translateElement(el)));
}
```

### 2. 缓存翻译结果

如需缓存（避免重复翻译相同的文本）：
```javascript
const translationCache = new Map();

async function translateWithCache(text) {
  if (translationCache.has(text)) {
    return translationCache.get(text);
  }
  const result = await handleTranslation(text, targetLang);
  translationCache.set(text, result);
  return result;
}
```

### 3. 延迟初始化

当前已实现，在页面加载 1 秒后开始翻译，给页面留出渲染时间。

## 故障排除

### Service Worker 未响应

1. 打开 `chrome://extensions/`
2. 找到插件，点击"Service worker"查看错误
3. 常见原因：语法错误、权限问题

### Content Script 未加载

1. 检查 manifest.json 的 `content_scripts` 配置
2. 刷新页面
3. 检查页面是否包含尝试加载限制的内容（如 about:, chrome://*）

### 跨域请求被阻止

- Content Script 无法直接调用外部 API
- 已通过 Service Worker + chrome.runtime.sendMessage 解决
- 如需直接调用，确保响应头包含 CORS 信息

---

**文档版本**: 1.0  
**最后更新**: 2024-03

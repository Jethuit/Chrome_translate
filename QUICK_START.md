# 🚀 LLM Translate 快速开始指南

## 一、5分钟快速配置

### 步骤 1：准备 API 信息

以 **OpenAI** 为例：
- 访问 https://platform.openai.com/api-keys
- 创建新的 API Key（记住要定级别和额度）
- 复制 API Key 备用

### 步骤 2：安装插件

Chrome 中：
1. 打开 `chrome://extensions/`
2. 右上角打开"开发者模式"
3. "加载已解压的扩展程序"
4. 选择本项目文件夹
5. ✅ 插件已安装

### 步骤 3：配置 API

1. 点击浏览器右上角的插件图标
2. 填写以下信息：

```
Base URL: https://api.openai.com/v1
Model ID: gpt-4o
API Key: sk-.... (您的 API Key)
```

3. 选择目标语言：中文
4. 点击"✓ 保存设置"

**完成！** ✨

---

## 二、使用方式

### 方式 1️⃣ : 自动翻译（推荐日文网站）

- 打开日文网站 → 自动翻译
- 原文下方显示蓝色翻译块
- 无需任何操作 ⏱️

### 方式 2️⃣ : 快捷键翻译（按需翻译）

```
1. 按住 Alt 键
2. 鼠标悬停在段落上
3. 2秒后自动翻译 ✓
4. 文本下显示翻译内容
```

### 方式 3️⃣ : 一键翻译整页面

```
1. 打开插件设置
2. 点击 "📝 翻译整个页面"
3. 等待翻译完成
4. 关闭设置窗口即可
```

---

## 三、支持的 API 服务

| 服务商 | Base URL | Model 示例 | 免费额度 |
|------|---------|---------|---------|
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o` | ❌ |
| **Ollama** (本地) | `http://localhost:11434/v1` | `llama2` | ✅ |
| **Hugging Face** | `https://api-inference.huggingface.co/v1` | 各种 | ✅ |
| **Groq** | `https://api.groq.com/openai/v1` | `mixtral-8x7b` | ✅ |

---

## 四、常见问题

**Q: 我的网站需要登录怎么办？**
```
A: 先登录网站，再打开本插件，已登录状态会保留
```

**Q: 翻译很慢？**
```
A: 可能是 API 响应慢
   - 检查网络连接
   - 尝试更换 Model（如用 gpt-3.5-turbo 会更快但质量稍低）
```

**Q: 如何关闭翻译？**
```
A: 两种方式：
   1. 点击插件 → 取消选中"启用翻译"
   2. 关闭插件（chrome://extensions/）
```

**Q: 能翻译图片中的文字吗？**
```
A: 不能。只能翻译网页中的文本内容。
```

---

## 五、高级技巧

### 只翻译某些段落

不想全页面翻译？使用快捷键模式：
- 按住 Alt 
- 只悬停在想翻译的段落上
- 只有当前段落会翻译

### 切换翻译语言

在插件设置中改变"目标语言"，下次加载页面自动用新语言翻译

### 使用本地 LLM（免费！）

安装 [Ollama](https://ollama.ai)：
```bash
# 下载 Ollama，安装 llama2 模型
ollama pull llama2

# 启动 Ollama 服务（自动在 localhost:11434 运行）
ollama serve
```

插件配置：
```
Base URL: http://localhost:11434/v1
Model ID: llama2
API Key: ollama
```

完全免费且离线运行！

---

## 六、故障排除

### "API 请求失败 (401)"
- ❌ API Key 可能过期或不正确
- ✅ 重新检查 API Key

### "翻译失败：网络错误"  
- ❌ Base URL 不可达
- ✅ 检查网址是否正确（https not http）
- ✅ 检查网络连接

### 插件不工作
- 🔄 刷新页面
- 🔄 重新加载插件（F5 in extensions page）
- 🔄 检查是否启用了翻译

---

## 七、更多帮助

遇到问题？

1. **检查浏览器控制台**：按 F12，查看 Console 标签
2. **查看完整文档**：[README.md](./README.md)
3. **常见 API 错误**：查看对应 API 文档

---

**祝你使用愉快！** 🎉

下次有问题时，记住这三步：
1. ❌ 检查 API 是否配置正确
2. ❌ 检查网络连接
3. ❌ 刷新页面重试

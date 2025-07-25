## 友链动态聚合项目

一个基于 Cloudflare Workers 的友链动态聚合服务，自动抓取友链站点的 RSS/Atom 订阅并聚合展示。
 `` 
功能特点

- 📡 自动抓取友链站点的 RSS/Atom 订阅
- 🚀 基于 Cloudflare Workers 的边缘计算部署
- ⚡️ 内置缓存机制提高响应速度
- 🌐 支持 CORS 跨域访问
- 📊 提供文章摘要和元数据

### 使用方法

fork下本仓库按文档改下配置文件就可以扔cloudflare worker跑了

 **注意：目前仅适配yaml格式的友联数据，能改就按下面的示例改下，不行提issue我手动适配，也别太离谱就行。** 

### 环境变量配置
以下环境变量可在 Cloudflare Workers 设置中进行配置：

变量名 | 必填 | 默认值 | 描述
-------- | --------- | -------- | --------
FRIENDS_YAML_URL | 是 | 无 |包含友链信息的 YAML 文件 URL
CACHE_TTL | 否 | 600 | 缓存时间（秒）
MAX_ENTRIES | 否 | 50 | 最大返回文章数量
DAYS_LIMIT | 否 | 30 | 只展示多少天内的文章
REQUEST_TIMEOUT | 否 | 10000 | RSS 请求超时时间（毫秒）
SUMMARY_LIMIT | 否| 	100	| 摘要最大长度（字符数），设置为0表示不截断，设置为负数表示禁用摘要功能


YAML 文件格式示例
``` yaml
- name: "博客名称"
  url: "https://blog.example.com"
  feed: "https://blog.example.com/feed.xml"
  # 可选字段
  avatar: "https://blog.example.com/avatar.jpg"
  quote: "博客描述"
```

## 前端使用指南

### 基本集成

在 HTML 页面中集成友链动态聚合：
```
<div id="friend-circle-container"></div>

<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<script>
  class FriendCircle {
    constructor() {
      this.container = document.getElementById('friend-circle-container');
      // 替换为您的 Worker URL
      this.workerUrl = "https://your-worker.your-subdomain.workers.dev";
      this.init();
    }
    
    async init() {
      try {
        const entries = await this.fetchData();
        this.render(entries);
      } catch (error) {
        this.showError(`加载失败: ${error.message}`);
      }
    }
    
    async fetchData() {
      const response = await fetch(this.workerUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }
    
    render(entries) {
      // 渲染逻辑
    }
    
    showError(message) {
      // 错误处理
    }
  }
  
  document.addEventListener('DOMContentLoaded', () => {
    new FriendCircle();
  });
</script>
```
完整集成模板
```
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>友链动态聚合</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    /* 卡片样式 */
    .friend-circle-card {
      background: white;
      border-radius: 10px;
      padding: 20px;
      margin: 15px 0;
      box-shadow: 0 3px 10px rgba(0,0,0,0.1);
    }
    
    .friend-circle-card h3 {
      margin-top: 0;
    }
    
    .friend-circle-meta {
      display: flex;
      justify-content: space-between;
      color: #666;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <div class="friend-circle-container">
    <h1><i class="fas fa-user-friends"></i> 友链动态聚合</h1>
    
    <div id="friend-circle-content">
      <div class="loading">
        正在加载友链动态...
      </div>
    </div>
  </div>

  <script>
    class FriendCircle {
      constructor() {
        this.container = document.getElementById('friend-circle-content');
        this.workerUrl = "https://your-worker.your-subdomain.workers.dev";
        this.init();
      }

      async init() {
        try {
          const entries = await this.fetchData();
          this.render(entries);
        } catch (error) {
          this.showError(`加载失败: ${error.message}`);
        }
      }

      async fetchData() {
        const response = await fetch(this.workerUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      }

      render(entries) {
        if (entries.error) {
          this.showError(entries.message);
          return;
        }
        
        if (entries.length === 0) {
          this.container.innerHTML = `
            <div class="empty-state">
              <i class="fas fa-inbox"></i>
              <h3>最近没有更新动态</h3>
              <p>暂无友链发布新内容</p>
            </div>
          `;
          return;
        }
        
        this.container.innerHTML = `
          <div class="friend-circle-list">
            ${entries.map(entry => `
              <div class="friend-circle-card">
                <h3><a href="${entry.link}" target="_blank">${entry.title}</a></h3>
                ${entry.summary ? `<p>${entry.summary}</p>` : ''}
                <div class="friend-circle-meta">
                  <div>
                    <i class="far fa-calendar"></i>
                    ${new Date(entry.date).toLocaleDateString()}
                  </div>
                  <div>
                    <i class="fas fa-globe"></i>
                    <a href="${entry.source.url}">${entry.source.name}</a>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        `;
      }
      
      showError(message) {
        this.container.innerHTML = `
          <div class="error">
            <p>${message}</p>
            <button class="retry-btn">重试</button>
          </div>
        `;
        document.querySelector('.retry-btn').addEventListener('click', () => this.init());
      }
    }

    document.addEventListener('DOMContentLoaded', () => {
      new FriendCircle();
    });
  </script>
</body>
</html>
```
### 部署指南

1. 创建 Cloudflare Worker

1. 登录 Cloudflare 控制台
2. 进入 Workers 页面
3. 创建新 Worker

2. 配置环境变量

在 Worker 的 "Settings" > "Variables" 中配置：

- 
"FRIENDS_YAML_URL": 您的友链 YAML 文件 URL
- (可选) 其他环境变量按需配置

3. 部署代码

将提供的 JavaScript 代码粘贴到 Worker 编辑器中并部署。

4. 前端集成

在您的网站中添加前端代码，并确保：

- 替换 Worker URL 为您的实际 Worker 地址
- 根据需要调整样式

### API 响应格式

API 返回 JSON 格式数据，结构如下：
``` json
[
  {
    "title": "文章标题",
    "link": "https://example.com/article",
    "date": "2025-07-17T12:00:00.000Z",
    "summary": "文章摘要内容...",
    "source": {
      "name": "博客名称",
      "site": "https://blog.example.com/",
      "url": "https://blog.example.com/"
    }
  },
  // 更多文章...
]
```
### 常见问题

Q: 为什么返回空数组？

可能原因：

1. YAML 文件未正确配置或无法访问
2. RSS 源解析失败
3. 没有符合时间条件的文章

解决方案：

1. 检查环境变量配置
2. 查看 Worker 日志
3. 增加 
"DAYS_LIMIT" 值

Q: 如何更新缓存？

缓存会根据 
"CACHE_TTL" 设置自动更新，也可以通过以下方式手动刷新：
```
// 在前端代码中添加时间戳参数
this.workerUrl = "https://your-worker.your-subdomain.workers.dev?t=" + Date.now();
```
### 贡献指南

本人代码功底有限，欢迎提交 Fork Pull 改进项目
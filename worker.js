import { parse } from 'yaml';
import { parseString } from 'xml2js';
import { env } from "cloudflare:workers";

// 配置获取函数
function getConfig(env) {
  const FRIENDS_YAML_URL = env.FRIENDS_YAML_URL;
  const CACHE_TTL = env.CACHE_TTL;
  const MAX_ENTRIES = env.MAX_ENTRIES;
  const DAYS_LIMIT = env.DAYS_LIMIT;
  const REQUEST_TIMEOUT = env.REQUEST_TIMEOUT;

  if (!FRIENDS_YAML_URL) {
    throw new Error(`FRIENDS_YAML_URL 环境变量未配置`);
  }
  
  return {
    friendsYamlUrl: FRIENDS_YAML_URL,
    cacheTTL: CACHE_TTL ? parseInt(CACHE_TTL) : 600,
    limit: MAX_ENTRIES ? parseInt(MAX_ENTRIES) : 50,
    daysLimit: DAYS_LIMIT ? parseInt(DAYS_LIMIT) : 30,
    timeout: REQUEST_TIMEOUT ? parseInt(REQUEST_TIMEOUT) : 10000,
  };
}

// 获取友链数据
async function fetchFriendsData(config) {
  const response = await fetch(config.friendsYamlUrl);
  if (!response.ok) {
    throw new Error(`获取友链数据失败: ${response.status}`);
  }
  const yamlText = await response.text();
  return parse(yamlText);
}

// 获取所有RSS源数据
async function fetchAllFeeds(friendsData, config) {
  const feedUrls = friendsData
    .filter(friend => friend.feed)
    .map(friend => ({
      url: friend.feed,
      name: friend.name,
      site: friend.site
    }));
  
  const results = await Promise.allSettled(
    feedUrls.map(item => fetchFeed(item.url, item.name, item.site, config))
  );
  
  return results.flatMap(result => 
    result.status === 'fulfilled' ? result.value : []
  );
}

// 从URL提取根域名
function extractBaseUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.protocol}//${parsedUrl.host}/`;
  } catch (e) {
    return null;
  }
}

// 获取单个RSS源
async function fetchFeed(url, name, site, config) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Cloudflare-Worker' }
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status}`);
    }
    
    const xml = await response.text();
    return await parseFeed(xml, name, site, config, url);
  } catch (error) {
    console.error(`获取RSS失败: ${url}`, error.message);
    return [];
  }
}

// 提取摘要内容
function extractSummary(item) {
  // 尝试获取带有 type="html" 的摘要
  if (item.summary && Array.isArray(item.summary)) {
    for (const summary of item.summary) {
      if (summary.$ && summary.$.type === "html") {
        return summary._ ? summary._.trim() : null;
      }
      return summary.trim();
    }
  }
  
  // 尝试获取普通摘要字段
  if (item.summary && Array.isArray(item.summary)) {
    return item.summary[0].trim();
  }
  
  // 尝试获取描述字段
  if (item.description && Array.isArray(item.description)) {
    return item.description[0].trim();
  }
  
  // 尝试获取内容字段
  if (item.content && Array.isArray(item.content)) {
    return item.content[0].trim();
  }
  
  // 都没有则返回null
  return null;
}

// 解析RSS源内容
function parseFeed(xml, name, site, config, feedUrl) {
  return new Promise((resolve) => {
    parseString(xml, (err, result) => {
      if (err) {
        console.error('XML解析失败', err.message);
        resolve([]);
        return;
      }
      
      try {
        const entries = [];
        const timeLimit = Date.now() - config.daysLimit * 86400000;
        
        // 获取基础URL（优先从YAML配置中获取，其次从feed URL提取）
        const baseUrl = site || extractBaseUrl(feedUrl) || extractBaseUrl(feedUrl);
        
        // 处理RSS 2.0格式
        if (result.rss?.channel) {
          const channel = result.rss.channel[0];
          (channel.item || []).forEach(item => {
            const pubDate = item.pubDate?.[0] || item.date?.[0];
            const entryDate = pubDate ? new Date(pubDate) : new Date();
            
            if (entryDate.getTime() > timeLimit) {
              entries.push({
                title: item.title?.[0]?.trim() || '无标题',
                link: item.link?.[0]?.trim() || '#',
                date: entryDate.toISOString(),
                summary: extractSummary(item),
                source: {
                  name,
                  site: baseUrl, // 使用基础URL
                  url: baseUrl   // 使用基础URL而不是具体页面
                }
              });
            }
          });
        } 
        // 处理Atom格式
        else if (result.feed) {
          const feed = result.feed;
          (feed.entry || []).forEach(item => {
            const updated = item.updated?.[0] || item.published?.[0];
            const entryDate = updated ? new Date(updated) : new Date();
            
            if (entryDate.getTime() > timeLimit) {
              const link = item.link?.find(l => l.$.rel === 'alternate')?.$.href || 
                           item.link?.[0]?.$.href || 
                           '#';
              
              entries.push({
                title: item.title?.[0]?._?.trim() || item.title?.[0]?.trim() || '无标题',
                link,
                date: entryDate.toISOString(),
                summary: extractSummary(item),
                source: {
                  name,
                  site: baseUrl, // 使用基础URL
                  url: baseUrl   // 使用基础URL而不是具体页面
                }
              });
            }
          });
        }
        
        console.log(`从 ${name} 解析 ${entries.length} 篇文章`);
        resolve(entries);
      } catch (parseError) {
        console.error('Feed解析异常', parseError.message);
        resolve([]);
      }
    });
  });
}

// 处理条目排序和限制
function processEntries(entries, config) {
  const allEntries = entries.flat();
  allEntries.sort((a, b) => 
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  return allEntries.slice(0, config.limit);
}

// 处理OPTIONS请求 (预检请求)
function handleOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400', // 24小时
    }
  });
}

// 使用ES模块格式导出Worker
export default {
  async fetch(request, env, ctx) {
    try {
      // 处理OPTIONS请求 (CORS预检)
      if (request.method === 'OPTIONS') {
        return handleOptions();
      }

      const config = getConfig(env);
      const cache = caches.default;
      const cachedResponse = await cache.match(request);
      
      if (cachedResponse) {
        // 缓存命中也要添加CORS头部
        const response = new Response(cachedResponse.body, cachedResponse);
        response.headers.set('Access-Control-Allow-Origin', '*');
        return response;
      }

      const friendsData = await fetchFriendsData(config);
      const feedEntries = await fetchAllFeeds(friendsData, config);
      const processedData = processEntries(feedEntries, config);
      
      // 创建响应并添加CORS头部
      const response = new Response(JSON.stringify(processedData), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${config.cacheTTL}`,
          'Access-Control-Allow-Origin': '*' // 允许所有域名访问
        }
      });
      
      ctx.waitUntil(cache.put(request.clone(), response.clone()));
      return response;
    } catch (error) {
      // 错误响应也要添加CORS头部
      return new Response(JSON.stringify({
        error: '请求处理失败',
        message: error.message
      }), { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};

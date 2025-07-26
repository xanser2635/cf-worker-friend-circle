import { parse } from 'yaml';
import { XMLParser } from 'fast-xml-parser';
import { env } from "cloudflare:workers";

// 配置获取函数
function getConfig(env) {
  const config = {
    friendsYamlUrl: env.FRIENDS_YAML_URL,
    cacheTTL: 600,
    limit: 50,
    daysLimit: 30,
    timeout: 10000,
    summaryLimit: 100
  };

  if (!config.friendsYamlUrl) {
    throw new Error(`FRIENDS_YAML_URL 环境变量未配置`);
  }

  // 类型安全的配置解析
  const parseIntSafe = (val, defaultValue) => 
    val && !isNaN(val) ? parseInt(val) : defaultValue;
  
  config.cacheTTL = parseIntSafe(env.CACHE_TTL, config.cacheTTL);
  config.limit = parseIntSafe(env.MAX_ENTRIES, config.limit);
  config.daysLimit = parseIntSafe(env.DAYS_LIMIT, config.daysLimit);
  config.timeout = parseIntSafe(env.REQUEST_TIMEOUT, config.timeout);
  config.summaryLimit = parseIntSafe(env.SUMMARY_LIMIT, config.summaryLimit);

  return config;
}

// fetch
async function fetchWithRetry(url, options = {}, retries = 2) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
}

// 获取友链数据带缓
async function fetchFriendsData(config) {
  const cacheKey = new Request(config.friendsYamlUrl);
  const cached = await caches.default.match(cacheKey);
  
  if (cached) {
    return parse(await cached.text());
  }

  try {
    const response = await fetchWithRetry(config.friendsYamlUrl, {
      timeout: config.timeout
    });
    
    const yamlText = await response.text();
    const data = parse(yamlText);
    
    // 缓存友链数据
    const cacheResponse = new Response(yamlText, {
      headers: { 'Cache-Control': `public, max-age=${3600}` } // 1小时
    });
    
    ctx.waitUntil(caches.default.put(cacheKey, cacheResponse.clone()));
    return data;
  } catch (error) {
    throw new Error(`获取友链数据失败: ${error.message}`);
  }
}

// 处理摘要截断
function truncateSummary(summary, limit) {
  if (!summary || limit <= 0) return null;
  
  // HTML标签移除
  const textOnly = summary
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  return textOnly.length <= limit 
    ? textOnly 
    : textOnly.substring(0, limit) + '...';
}

// 获取单个RSS源
async function fetchFeed(url, name, config) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);
  
  try {
    const response = await fetchWithRetry(url, {
      signal: controller.signal,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (compatible; Cloudflare-Worker)',
        'Accept': 'application/rss+xml, application/xml'
      }
    });
    
    clearTimeout(timeoutId);
    const xml = await response.text();
    return parseFeed(xml, name, config);
  } catch (error) {
    // 区分超时和其他错误
    const errorType = error.name === 'AbortError' ? '请求超时' : '请求失败';
    console.error(`[${name}] RSS ${errorType}: ${url}`, error.message);
    return [];
  }
}

// 使用fast-xml-parser解析
function parseFeed(xml, name, config) {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseTagValue: true,
      parseAttributeValue: true,
      allowBooleanAttributes: true,
      stopNodes: ['*.description', '*.content', '*.summary'],
      processEntities: false
    });
    
    const result = parser.parse(xml);
    const entries = [];
    const timeLimit = Date.now() - config.daysLimit * 86400000;

    // 处理RSS格式
    if (result.rss?.channel) {
      const items = Array.isArray(result.rss.channel.item)
        ? result.rss.channel.item
        : [result.rss.channel.item];
      
      for (const item of items) {
        if (!item) continue;
        
        const pubDate = item.pubDate || item.date;
        const entryDate = pubDate ? new Date(pubDate) : new Date();
        if (entryDate.getTime() < timeLimit) continue;
        
        const rawSummary = item.description || item.content || item.summary;
        
        entries.push({
          title: item.title?.trim() || '无标题',
          link: item.link?.trim() || '#',
          date: entryDate.toISOString(),
          summary: truncateSummary(rawSummary, config.summaryLimit),
          source: { name }
        });
      }
    } 
    // 处理Atom格式
    else if (result.feed) {
      const entriesAtom = Array.isArray(result.feed.entry)
        ? result.feed.entry
        : [result.feed.entry];
      
      for (const entry of entriesAtom) {
        if (!entry) continue;
        
        const updated = entry.updated || entry.published;
        const entryDate = updated ? new Date(updated) : new Date();
        if (entryDate.getTime() < timeLimit) continue;
        
        const link = Array.isArray(entry.link)
          ? entry.link.find(l => l.rel === 'alternate')?.href || entry.link[0]?.href
          : entry.link?.href;
        
        const rawSummary = entry.summary?._text || entry.content?._text;
        
        entries.push({
          title: (entry.title?._text || entry.title)?.trim() || '无标题',
          link: link || '#',
          date: entryDate.toISOString(),
          summary: truncateSummary(rawSummary, config.summaryLimit),
          source: { name }
        });
      }
    }
    
    console.log(`[${name}] 成功解析 ${entries.length} 篇文章`);
    return entries;
  } catch (error) {
    console.error(`[${name}] XML解析失败: ${error.message}`);
    return [];
  }
}

// 处理OPTIONS请求
function handleOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    // 处理OPTIONS请求
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    try {
      const config = getConfig(env);
      const cache = caches.default;
      const cachedResponse = await cache.match(request);
      
      if (cachedResponse) {
        return cachedResponse;
      }

      const friendsData = await fetchFriendsData(config);
      const feedEntries = await Promise.allSettled(
        friendsData
          .filter(f => f.feed)
          .map(f => fetchFeed(f.feed, f.name, config))
      );
      
      const successfulEntries = feedEntries
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);
      
      const processedData = successfulEntries
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, config.limit);
      
      const response = new Response(JSON.stringify(processedData), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${config.cacheTTL}`,
          'Access-Control-Allow-Origin': '*'
        }
      });
      
      ctx.waitUntil(cache.put(request, response.clone()));
      return response;
    } catch (error) {
      return new Response(JSON.stringify({
        error: '服务器错误',
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

import { parse } from 'yaml';
import { parseString } from 'xml2js';

import 'node:events';
import 'node:perf_hooks';
import 'node:stream';
import 'node:tty';
import 'string_decoder';
import 'timers';

// 从环境变量获取配置
const getConfig = (env) => {
  if (!env.FRIENDS_YAML_URL) {
    throw new Error('FRIENDS_YAML_URL 环境变量未配置');
  }
  
  return {
    friendsYamlUrl: env.FRIENDS_YAML_URL,
    cacheTTL: env.CACHE_TTL ? parseInt(env.CACHE_TTL) : 600,
    limit: env.MAX_ENTRIES ? parseInt(env.MAX_ENTRIES) : 50,
    daysLimit: env.DAYS_LIMIT ? parseInt(env.DAYS_LIMIT) : 30,
    timeout: env.REQUEST_TIMEOUT ? parseInt(env.REQUEST_TIMEOUT) : 10000,
  };
};

// 默认导出模块格式Worker
export default {
  async fetch(request, env, ctx) {
    try {
      // 构建模拟event对象
      const event = {
        request,
        env,
        ctx
      };
      
      return await handleRequest(event);
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Worker初始化失败', 
        message: error.message 
      }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

async function handleRequest(event) {
  try {
    const config = getConfig(event.env);
    
    // 使用标准请求对象处理缓存
    const cache = caches.default;
    const cachedResponse = await cache.match(event.request);
    if (cachedResponse) {
      return cachedResponse;
    }

    // 获取友链数据
    const friendsData = await fetchFriendsData(config);
    
    // 获取所有RSS feed
    const feedEntries = await fetchAllFeeds(friendsData, config);
    
    // 处理数据
    const processedData = processEntries(feedEntries, config);
    
    // 构建响应
    const response = new Response(JSON.stringify(processedData), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${config.cacheTTL}`
      }
    });
    
    // 使用ctx.waitUntil处理后台任务
    event.ctx.waitUntil(cache.put(event.request.clone(), response.clone()));
    return response;
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: '请求处理失败', 
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function fetchFriendsData(config) {
  const response = await fetch(config.friendsYamlUrl);
  if (!response.ok) {
    throw new Error(`获取友链数据失败: ${response.status}`);
  }
  
  const yamlText = await response.text();
  return parse(yamlText);
}

async function fetchAllFeeds(friendsData, config) {
  // 提取有效的feed URL
  const feedUrls = friendsData
    .filter(friend => friend.rss)
    .map(friend => ({
      url: friend.rss,
      name: friend.name,
      site: friend.site
    }));
  
  // 并发请求所有feed
  const results = await Promise.allSettled(
    feedUrls.map(item => fetchFeed(item.url, item.name, item.site, config))
  );
  
  // 合并成功的结果
  return results.flatMap(result => 
    result.status === 'fulfilled' ? result.value : []
  );
}

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
      throw new Error(`HTTP ${response.status}`);
    }
    
    const xml = await response.text();
    return await parseFeed(xml, name, site, config);
  } catch (error) {
    console.error(`获取RSS失败: ${url}`, error);
    return [];
  }
}

function parseFeed(xml, name, site, config) {
  return new Promise((resolve, reject) => {
    parseString(xml, (err, result) => {
      if (err) {
        console.error('XML解析失败', err);
        resolve([]);
        return;
      }
      
      try {
        const entries = [];
        const timeLimit = Date.now() - config.daysLimit * 86400000;
        
        // 解析RSS格式
        if (result.rss && result.rss.channel) {
          const channel = result.rss.channel[0];
          const items = channel.item || [];
          
          items.forEach(item => {
            const pubDate = item.pubDate?.[0] || item.date?.[0];
            const entryDate = pubDate ? new Date(pubDate) : new Date();
            
            if (entryDate.getTime() > timeLimit) {
              entries.push({
                title: item.title?.[0]?.trim() || '无标题',
                link: item.link?.[0]?.trim() || '#',
                date: entryDate.toISOString(),
                source: {
                  name,
                  site,
                  url: channel.link?.[0]?.trim() || site
                }
              });
            }
          });
        } 
        // 解析Atom格式
        else if (result.feed) {
          const feed = result.feed;
          const items = feed.entry || [];
          
          items.forEach(item => {
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
                source: {
                  name,
                  site,
                  url: feed.link?.find(l => l.$.rel === 'alternate')?.$.href || 
                       feed.link?.[0]?.$.href || 
                       site
                }
              });
            }
          });
        }
        
        resolve(entries);
      } catch (parseError) {
        console.error('Feed解析异常', parseError);
        resolve([]);
      }
    });
  });
}

function processEntries(entries, config) {
  // 合并所有条目
  const allEntries = entries.flat();
  
  // 按日期排序（从新到旧）
  allEntries.sort((a, b) => 
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  
  // 限制返回数量
  return allEntries.slice(0, config.limit);
}

import { parse } from 'yaml';
import { parseString } from 'xml2js';

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
    .filter(friend => friend.rss)
    .map(friend => ({
      url: friend.rss,
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
    return await parseFeed(xml, name, site, config);
  } catch (error) {
    console.error(`获取RSS失败: ${url}`, error.message);
    return [];
  }
}

// 解析RSS源内容
function parseFeed(xml, name, site, config) {
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
                source: {
                  name,
                  site,
                  url: channel.link?.[0]?.trim() || site
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

// 使用ES模块格式导出Worker
export default {
  async fetch(request, env, ctx) {
    try {
      const config = getConfig(env);
      const cache = caches.default;
      const cachedResponse = await cache.match(request);
      
      if (cachedResponse) {
        return cachedResponse;
      }

      const friendsData = await fetchFriendsData(config);
      const feedEntries = await fetchAllFeeds(friendsData, config);
      const processedData = processEntries(feedEntries, config);
      
      const response = new Response(JSON.stringify(processedData), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${config.cacheTTL}`
        }
      });
      
      ctx.waitUntil(cache.put(request.clone(), response.clone()));
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
};

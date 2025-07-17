import { parse } from 'yaml';
import { parseString } from 'xml2js';
import 'node:events';
import 'node:perf_hooks';
import 'node:stream';
import 'node:tty';
import 'string_decoder';
import 'timers';

// 从环境变量获取配置
  
  if (FRIENDS_YAML_URL) {
    const errorMsg = `FRIENDS_YAML_URL 环境变量未配置。当前环境变量: ${JSON.stringify(env)}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  
  return {
    friendsYamlUrl: FRIENDS_YAML_URL,
    cacheTTL: CACHE_TTL ? parseInt(CACHE_TTL) : 600,
    limit: MAX_ENTRIES ? parseInt(MAX_ENTRIES) : 50,
    daysLimit: DAYS_LIMIT ? parseInt(DAYS_LIMIT) : 30,
    timeout: REQUEST_TIMEOUT ? parseInt(REQUEST_TIMEOUT) : 10000,
  };
};

// 定义Worker对象
const worker = {
  async fetch(request, env, ctx) {
    try {
      console.log("请求处理开始，环境变量:", Object.keys(env));
      
      const config = getConfig(env);
      const cache = caches.default;
      const cachedResponse = await cache.match(request);
      
      if (cachedResponse) {
        console.log("返回缓存响应");
        return cachedResponse;
      }

      console.log("获取友链数据:", config.friendsYamlUrl);
      const friendsData = await fetchFriendsData(config);
      
      console.log("获取RSS feed");
      const feedEntries = await fetchAllFeeds(friendsData, config);
      
      console.log("处理数据");
      const processedData = processEntries(feedEntries, config);
      
      const response = new Response(JSON.stringify(processedData), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${config.cacheTTL}`
        }
      });
      
      ctx.waitUntil(cache.put(request.clone(), response.clone()));
      console.log("请求处理成功");
      return response;
    } catch (error) {
      const errorDetails = {
        error: '请求处理失败',
        message: error.message,
        envKeys: Object.keys(env),
        stack: error.stack
      };
      
      console.error("请求处理错误:", errorDetails);
      return new Response(JSON.stringify(errorDetails), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// 导出Worker对象
export default worker;

// 辅助函数
async function fetchFriendsData(config) {
  const response = await fetch(config.friendsYamlUrl);
  if (!response.ok) {
    throw new Error(`获取友链数据失败: ${response.status} - ${response.statusText}`);
  }
  
  const yamlText = await response.text();
  return parse(yamlText);
}

async function fetchAllFeeds(friendsData, config) {
  const feedUrls = friendsData
    .filter(friend => friend.rss)
    .map(friend => ({
      url: friend.rss,
      name: friend.name,
      site: friend.site
    }));
  
  console.log(`找到 ${feedUrls.length} 个RSS源`);
  
  const results = await Promise.allSettled(
    feedUrls.map(item => fetchFeed(item.url, item.name, item.site, config))
  );
  
  return results.flatMap(result => 
    result.status === 'fulfilled' ? result.value : []
  );
}

async function fetchFeed(url, name, site, config) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);
  
  try {
    console.log(`请求RSS源: ${url}`);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Cloudflare-Worker' }
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status} - ${response.statusText}`);
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
        
        console.log(`从 ${name} 解析 ${entries.length} 篇文章`);
        resolve(entries);
      } catch (parseError) {
        console.error('Feed解析异常', parseError);
        resolve([]);
      }
    });
  });
}

function processEntries(entries, config) {
  const allEntries = entries.flat();
  allEntries.sort((a, b) => 
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  return allEntries.slice(0, config.limit);
}

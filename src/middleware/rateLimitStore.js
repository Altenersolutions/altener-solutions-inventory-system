const Redis = require("ioredis");
const stores = new Set();

class RedisRateLimitStore {
  constructor({ prefix, windowMs }) {
    this.prefix = prefix;
    this.windowMs = windowMs;
    this.client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.client.on("error", (err) => console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "Redis rate-limit store error", prefix, error: err.message })));
    stores.add(this);
  }

  async init() {
    if (this.client.status === "wait") await this.client.connect();
  }

  key(key) {
    return `${this.prefix}:${key}`;
  }

  async increment(key) {
    await this.init();
    const redisKey = this.key(key);
    const totalHits = await this.client.incr(redisKey);
    let resetMs = await this.client.pttl(redisKey);
    if (totalHits === 1 || resetMs < 0) {
      await this.client.pexpire(redisKey, this.windowMs);
      resetMs = this.windowMs;
    }
    return { totalHits, resetTime: new Date(Date.now() + resetMs) };
  }

  async decrement(key) {
    await this.init();
    const redisKey = this.key(key);
    const totalHits = await this.client.decr(redisKey);
    return Math.max(0, totalHits);
  }

  async resetKey(key) {
    await this.init();
    await this.client.del(this.key(key));
  }

  async resetAll() {
    await this.init();
    const keys = await this.client.keys(`${this.prefix}:*`);
    if (keys.length) await this.client.del(keys);
  }

  close() {
    if (this.client.status !== "end") this.client.disconnect();
    stores.delete(this);
  }
}

function sharedStore({ prefix, windowMs }) {
  return process.env.REDIS_URL ? new RedisRateLimitStore({ prefix, windowMs }) : undefined;
}

function closeRateLimitStores() {
  for (const store of stores) store.close();
}

module.exports = { RedisRateLimitStore, sharedStore, closeRateLimitStores };

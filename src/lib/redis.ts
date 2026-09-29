import Redis from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

/**
 * Minimal key/value facade used by presence and typing coordination.
 * Backed by Redis when REDIS_URL is configured, otherwise by an in-process
 * memory store so a single instance works with zero infrastructure.
 */
export interface KVStore {
  incr(key: string, ttlSeconds: number): Promise<number>;
  decr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, ttlSeconds: number): Promise<void>;
  setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

class MemoryStore implements KVStore {
  private entries = new Map<string, MemoryEntry>();

  private isAlive(entry: MemoryEntry | undefined): entry is MemoryEntry {
    return entry !== undefined && (entry.expiresAt === null || entry.expiresAt > Date.now());
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.entries.get(key);
    const current = this.isAlive(entry) ? Number(entry.value) : 0;
    const next = current + 1;
    this.entries.set(key, { value: String(next), expiresAt: Date.now() + ttlSeconds * 1000 });
    return next;
  }

  async decr(key: string): Promise<number> {
    const entry = this.entries.get(key);
    const current = this.isAlive(entry) ? Number(entry.value) : 0;
    const next = Math.max(0, current - 1);
    if (next === 0) this.entries.delete(key);
    else this.entries.set(key, { value: String(next), expiresAt: null });
    return next;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    return this.isAlive(entry) ? entry.value : null;
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.isAlive(this.entries.get(key))) return false;
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.entries.get(key);
    if (this.isAlive(entry)) {
      this.entries.set(key, { value: entry.value, expiresAt: Date.now() + ttlSeconds * 1000 });
    }
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    const values: (string | null)[] = [];
    for (const key of keys) values.push(await this.get(key));
    return values;
  }
}

class RedisStore implements KVStore {
  constructor(private readonly client: Redis) {}

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.client.incr(key);
    await this.client.expire(key, ttlSeconds);
    return value;
  }

  async decr(key: string): Promise<number> {
    const value = await this.client.decr(key);
    if (value <= 0) await this.client.del(key);
    return Math.max(0, value);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, "EX", ttlSeconds);
  }

  async setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.client.del(...keys);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    return this.client.mget(...keys);
  }
}

const KEY_PREFIX = "chatme:";

let store: KVStore = new MemoryStore();
let redis: Redis | null = null;

export function getStore(): KVStore {
  return store;
}

export function isRedisEnabled(): boolean {
  return redis !== null;
}

export function prefixed(key: string): string {
  return KEY_PREFIX + key;
}

export function makeRedisClient(): Redis {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is not configured");
  // maxRetriesPerRequest: null is required for pub/sub clients and for the
  // Socket.IO redis adapter (commands must queue instead of failing fast).
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export async function initRedis(): Promise<void> {
  if (!env.REDIS_URL) {
    logger.info("Redis not configured — single-instance mode (in-memory presence/typing/pubsub)");
    return;
  }
  const client = makeRedisClient();
  try {
    await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Redis PING timed out")), 10_000),
      ),
    ]);
  } catch (error) {
    client.disconnect();
    throw new Error(
      `Failed to connect to Redis (REDIS_URL): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  redis = client;
  store = new RedisStore(client);
  logger.info("Redis connected", { url: env.REDIS_URL.replace(/\/\/.*@/, "//***@") });
}

export async function closeRedis(): Promise<void> {
  const client = redis;
  redis = null;
  store = new MemoryStore();
  if (!client) return;
  await client.quit().catch(() => client.disconnect());
}

import Redis, {
  Cluster,
  ClusterNode,
  ClusterOptions,
  RedisOptions,
} from 'ioredis';

import type { Cache, Store, Config } from 'cache-manager';

export type Options = Config & {
  throwNoncacheable?: boolean;
};

export type RedisCache = Cache<RedisStore>;

export interface RedisStore extends Store {
  readonly isCacheable: (value: unknown) => boolean;
  get client(): Redis | Cluster;
}

const getVal = (value: unknown) => JSON.stringify(value) || '"undefined"';

function builder(
  redisCache: Redis | Cluster,
  reset: () => Promise<void>,
  keys: (pattern: string) => Promise<string[]>,
  options?: Options,
) {
  const isCacheable =
    options?.isCacheable || ((value) => value !== undefined && value !== null);

  const throwNoncacheable =
    options?.throwNoncacheable === undefined ? true : options.throwNoncacheable;

  return {
    async get<T>(key: string) {
      const val = await redisCache.get(key);
      if (val === undefined || val === null) return undefined;
      else return JSON.parse(val) as T;
    },
    async set(key, value, ttl) {
      if (!isCacheable(value)) {
        if (throwNoncacheable)
          throw new Error(`"${value}" is not a cacheable value`);
        else return;
      }
      const t = ttl === undefined ? options?.ttl : ttl;
      if (t) await redisCache.setex(key, t, getVal(value));
      else await redisCache.set(key, getVal(value));
    },
    async mset(args, ttl) {
      const t = ttl === undefined ? options?.ttl : ttl;
      if (t) {
        const multi = redisCache.multi();
        for (const [key, value] of args) {
          if (!isCacheable(value)) {
            if (throwNoncacheable)
              throw new Error(`"${getVal(value)}" is not a cacheable value`);
            else continue;
          }
          multi.setex(key, t / 1000, getVal(value));
        }
        await multi.exec();
      } else
        await redisCache.mset(
          args.flatMap(([key, value]) => {
            if (!isCacheable(value)) {
              if (throwNoncacheable)
                throw new Error(`"${getVal(value)}" is not a cacheable value`);
              else return [];
            }
            return [key, getVal(value)] as [string, string];
          }),
        );
    },
    mget: (...args) =>
      redisCache
        .mget(args)
        .then((x) =>
          x.map((x) =>
            x === null || x === undefined
              ? undefined
              : (JSON.parse(x) as unknown),
          ),
        ),
    async mdel(...args) {
      await redisCache.del(args);
    },
    async del(key) {
      await redisCache.del(key);
    },
    ttl: async (key) => redisCache.ttl(key),
    keys: (pattern = '*') => keys(pattern),
    reset,
    isCacheable,
    get client() {
      return redisCache;
    },
  } as RedisStore;
}

export interface RedisClusterConfig {
  nodes: ClusterNode[];
  options?: ClusterOptions;
}

export async function redisStore(
  options?: (RedisOptions | { clusterConfig: RedisClusterConfig }) & Options,
) {
  options ||= {};
  const redisCache =
    'clusterConfig' in options
      ? new Redis.Cluster(
          options.clusterConfig.nodes,
          options.clusterConfig.options,
        )
      : new Redis(options);

  return redisInsStore(redisCache, options);
}

export function redisInsStore(redisCache: Redis | Cluster, options?: Options) {
  const reset = async () => {
    await redisCache.flushall();
  };
  const keys = (pattern: string) => redisCache.keys(pattern);

  return builder(redisCache, reset, keys, options);
}

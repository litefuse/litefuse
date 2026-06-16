## Caching Strategy of API Keys

### Cache Structure

The cache for API keys is stored in the single-node in-memory app cache. The cache key looks like the following: `api-key:<fast-hash>`. The hash is the `fastHashedSecretKey` from Postgres, so the cache entry can still be invalidated directly from database lookups.

### Creation and updates of API keys

When creating a new API key, nothing happens in the cache. The API key is only created in the database. There are no functionalities in Litefuse to update API keys.

### Reading API keys

When reading API keys, we prefer to get the key from the in-memory cache and reset the TTL on each read to keep hot entries alive. If the key is not found in cache, we read from Postgres and store it in the cache.

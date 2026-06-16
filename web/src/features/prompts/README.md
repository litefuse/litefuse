## Caching Strategy of Prompts

The caching strategy for prompts is implemented in the `PromptService` class and is utilized in the `createPrompt` function. Here is an overview of how the caching mechanism works:

### Cache Structure

The cache for prompts is managed using the single-node in-memory app cache. The cache key looks like the following: `prompt:<project-id>:<epoch>:<prompt-name>:<version-or-label>`. This means that for each prompt name we can have multiple cached entries, and epoch rotation invalidates a whole project namespace without deleting rows synchronously.

### Creation and updates of prompts

We never update prompts in the cache. Instead, we remove all cache entries for a prompt name of a project when a prompt is updated. This ensures that the cache is always up-to-date with the database.
For this, we rotate the project cache epoch before subsequent reads repopulate the fresh namespace.

### Reading prompts

When reading prompts, we first derive the current project epoch and try the matching cache key. On cache hit, we refresh the TTL so the entry remains hot. If the entry is not in cache, we read the prompt from Postgres and store it in the cache.

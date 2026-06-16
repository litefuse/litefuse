import {
  clearLocalAppCache,
  deleteAppCacheByPrefix,
  getAppCacheValue,
  getLocalAppCacheEntryForTest,
  getLocalAppCacheKeysForTest,
} from "../cache/appCache";

export const getAppCacheEntry = async (key: string) => {
  return getLocalAppCacheEntryForTest(key);
};

export const getAppCacheValueForTest = async <T>(
  key: string,
): Promise<T | null> => {
  return getAppCacheValue<T>(key);
};

export const clearAppCacheByPrefix = async (prefix: string): Promise<void> => {
  await deleteAppCacheByPrefix(prefix);
};

export const clearLocalAppCacheForTest = (): void => {
  clearLocalAppCache();
};

export const getLocalAppCacheKeysSnapshot = (): string[] =>
  getLocalAppCacheKeysForTest();

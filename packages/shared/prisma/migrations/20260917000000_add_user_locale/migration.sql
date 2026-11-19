-- Account-level UI language preference (BCP-47 tag such as "zh-CN"). Null
-- means "not set": the device cookie / Accept-Language decide.
ALTER TABLE "users" ADD COLUMN "locale" TEXT;

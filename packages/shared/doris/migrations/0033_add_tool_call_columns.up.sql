ALTER TABLE observation_source ADD COLUMN `tool_definitions` Map<String, String> NULL;
ALTER TABLE observation_source ADD COLUMN `tool_calls` ARRAY<String> NULL;
ALTER TABLE observation_source ADD COLUMN `tool_call_names` ARRAY<String> NULL;

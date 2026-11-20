ALTER TABLE "blob_storage_integrations"
  ADD COLUMN IF NOT EXISTS "export_field_groups" TEXT[] NOT NULL DEFAULT ARRAY[
    'core', 'basic', 'time', 'io', 'metadata', 'model', 'usage', 'prompt', 'metrics'
  ],
  ADD COLUMN IF NOT EXISTS "compressed" BOOLEAN NOT NULL DEFAULT true;

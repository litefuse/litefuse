-- Evaluators v2 data model: the four tables, their enums and the extra
-- EvaluatorBlockReason members.
--
-- Why this migration exists: 20261010120000_add_evaluator_v2_enums_and_tables was
-- written against a database that already had the tables — they came from an
-- earlier, since-reverted attempt at the same migration — so it only creates the
-- one enum that was genuinely missing there and adopts the tables without
-- recreating them. On a database built from scratch by `prisma migrate deploy`
-- (CI runs `pnpm turbo db:deploy`, and so does any fresh checkout) the tables were
-- therefore never created at all: `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel` against a freshly migrated database reported the four
-- tables, six indexes and eight foreign keys below as missing. This migration
-- adds them properly, so a clean database now ends up matching schema.prisma.
--
-- Every statement is guarded (IF NOT EXISTS, or a duplicate_object catch) because
-- the objects already exist in databases where the tables predate this migration;
-- there this file is a no-op.
--
-- Deliberately not included: the unrelated `stripe_webhook_events.updated_at`
-- drift that the same diff reports. Upstream's own 20260713120000 migration
-- creates that column without the DEFAULT that schema.prisma declares, so it is an
-- upstream inconsistency and out of scope here.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "EvalTemplateType" AS ENUM ('LLM_AS_JUDGE', 'CODE', 'DECISION_MODEL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "EvaluatorSourceCodeLanguage" AS ENUM ('PYTHON', 'TYPESCRIPT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum
ALTER TYPE "EvaluatorBlockReason" ADD VALUE IF NOT EXISTS 'LLM_CONNECTION_BILLING_EXHAUSTED';
ALTER TYPE "EvaluatorBlockReason" ADD VALUE IF NOT EXISTS 'LLM_CONNECTION_ENDPOINT_UNREACHABLE';

-- CreateTable
CREATE TABLE IF NOT EXISTS "evaluators" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EvalTemplateType" NOT NULL,
    "description" TEXT,
    "created_by_user_id" TEXT,
    "blocked_at" TIMESTAMP(3),
    "block_reason" "EvaluatorBlockReason",
    "block_message" TEXT,

    CONSTRAINT "evaluators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "evaluator_versions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluator_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_by_user_id" TEXT,
    "prompt" TEXT,
    "prompt_messages" JSONB,
    "partner" TEXT,
    "model" TEXT,
    "provider" TEXT,
    "model_params" JSONB,
    "vars" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "variable_mapping" JSONB,
    "output_definition" JSONB,
    "source_code" VARCHAR(262144),
    "source_code_language" "EvaluatorSourceCodeLanguage",
    "questions" JSONB,

    CONSTRAINT "evaluator_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "evaluation_rules" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "project_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "name" TEXT NOT NULL,
    "status" "JobConfigState" NOT NULL DEFAULT 'ACTIVE',
    "target_object" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "sampling" DECIMAL(65,30) NOT NULL,
    "delay" INTEGER NOT NULL,
    "time_scope" TEXT[] DEFAULT ARRAY['NEW']::TEXT[],

    CONSTRAINT "evaluation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "evaluation_rule_evaluator_assignments" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "project_id" TEXT NOT NULL,
    "evaluation_rule_id" TEXT NOT NULL,
    "evaluator_id" TEXT NOT NULL,
    "variable_mapping" JSONB,

    CONSTRAINT "evaluation_rule_evaluator_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "evaluators_project_id_created_at_idx" ON "evaluators"("project_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "evaluator_versions_evaluator_id_version_key" ON "evaluator_versions"("evaluator_id", "version" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "evaluation_rules_project_id_updated_at_idx" ON "evaluation_rules"("project_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "evaluation_rule_assignments_project_id_idx" ON "evaluation_rule_evaluator_assignments"("project_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "evaluation_rule_assignments_evaluator_id_idx" ON "evaluation_rule_evaluator_assignments"("evaluator_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_rule_assignments_rule_evaluator_key" ON "evaluation_rule_evaluator_assignments"("evaluation_rule_id", "evaluator_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluators" ADD CONSTRAINT "evaluators_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluators" ADD CONSTRAINT "evaluators_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluator_versions" ADD CONSTRAINT "evaluator_versions_evaluator_id_fkey" FOREIGN KEY ("evaluator_id") REFERENCES "evaluators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluator_versions" ADD CONSTRAINT "evaluator_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluation_rules" ADD CONSTRAINT "evaluation_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluation_rules" ADD CONSTRAINT "evaluation_rules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluation_rule_evaluator_assignments" ADD CONSTRAINT "evaluation_rule_evaluator_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluation_rule_evaluator_assignments" ADD CONSTRAINT "evaluation_rule_evaluator_assignments_evaluation_rule_id_fkey" FOREIGN KEY ("evaluation_rule_id") REFERENCES "evaluation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "evaluation_rule_evaluator_assignments" ADD CONSTRAINT "evaluation_rule_evaluator_assignments_evaluator_id_fkey" FOREIGN KEY ("evaluator_id") REFERENCES "evaluators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

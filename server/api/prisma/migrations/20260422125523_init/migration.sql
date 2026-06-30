-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'pro', 'enterprise');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('mobile', 'desktop', 'tablet', 'bot', 'unknown');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'free',
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "user_agent" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "urls" (
    "id" BIGSERIAL NOT NULL,
    "short_code" VARCHAR(12) NOT NULL,
    "original_url" TEXT NOT NULL,
    "user_id" UUID,
    "custom_alias" VARCHAR(50),
    "expires_at" TIMESTAMPTZ(6),
    "click_count" BIGINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "is_flagged" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "click_events" (
    "id" BIGSERIAL NOT NULL,
    "url_id" BIGINT NOT NULL,
    "clicked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" VARCHAR(64) NOT NULL,
    "country_code" CHAR(2),
    "city" VARCHAR(100),
    "device_type" "DeviceType" NOT NULL DEFAULT 'unknown',
    "browser" VARCHAR(50),
    "os" VARCHAR(50),
    "referrer_domain" VARCHAR(255),
    "is_unique" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "click_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_analytics_aggregates" (
    "url_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "total_clicks" INTEGER NOT NULL DEFAULT 0,
    "unique_clicks" INTEGER NOT NULL DEFAULT 0,
    "top_countries" JSONB NOT NULL DEFAULT '{}',
    "top_referrers" JSONB NOT NULL DEFAULT '{}',
    "device_breakdown" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "daily_analytics_aggregates_pkey" PRIMARY KEY ("url_id","date")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_plan_idx" ON "users"("plan");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "urls_short_code_key" ON "urls"("short_code");

-- CreateIndex
CREATE UNIQUE INDEX "urls_custom_alias_key" ON "urls"("custom_alias");

-- CreateIndex
CREATE INDEX "urls_user_id_created_at_idx" ON "urls"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "urls_expires_at_idx" ON "urls"("expires_at");

-- CreateIndex
CREATE INDEX "click_events_url_id_clicked_at_idx" ON "click_events"("url_id", "clicked_at" DESC);

-- CreateIndex
CREATE INDEX "daily_analytics_aggregates_date_idx" ON "daily_analytics_aggregates"("date" DESC);

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "urls" ADD CONSTRAINT "urls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_url_id_fkey" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_analytics_aggregates" ADD CONSTRAINT "daily_analytics_aggregates_url_id_fkey" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AppConfig: opt-in provider allowlist
ALTER TABLE "AppConfig" ADD COLUMN "enabledProviders" TEXT[] NOT NULL DEFAULT '{}';

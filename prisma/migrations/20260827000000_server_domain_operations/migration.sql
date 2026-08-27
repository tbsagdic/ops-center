-- Sunucu domain kontrolü: nginx üzerinde domain ekleme/değiştirme otomasyonu.

CREATE TYPE "ServerWebStack" AS ENUM ('nginx');
CREATE TYPE "ServerDomainOpType" AS ENUM ('add', 'change');
CREATE TYPE "ServerDomainOpStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'rolled_back');

ALTER TABLE "servers"
  ADD COLUMN "ssh_sudo_password_encrypted" TEXT,
  ADD COLUMN "ssh_host_fingerprint" TEXT,
  ADD COLUMN "web_stack" "ServerWebStack",
  ADD COLUMN "nginx_sites_path" TEXT;

ALTER TABLE "domains" ADD COLUMN "server_id" UUID;

ALTER TABLE "domains"
  ADD CONSTRAINT "domains_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "domains_workspace_id_server_id_idx" ON "domains" ("workspace_id", "server_id");

CREATE TABLE "server_domain_operations" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "server_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "type" "ServerDomainOpType" NOT NULL,
  "status" "ServerDomainOpStatus" NOT NULL DEFAULT 'pending',
  "new_domain" TEXT NOT NULL,
  "old_domain" TEXT,
  "include_www" BOOLEAN NOT NULL DEFAULT true,
  "enable_ssl" BOOLEAN NOT NULL DEFAULT true,
  "ssl_email" TEXT,
  "redirect_old" BOOLEAN NOT NULL DEFAULT true,
  "document_root" TEXT,
  "proxy_pass" TEXT,
  "steps" JSONB NOT NULL,
  "context" JSONB,
  "current_step" INTEGER NOT NULL DEFAULT 0,
  "backup_path" TEXT,
  "log" JSONB,
  "error" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "server_domain_operations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "server_domain_operations_workspace_id_created_at_idx"
  ON "server_domain_operations" ("workspace_id", "created_at");
CREATE INDEX "server_domain_operations_workspace_id_server_id_idx"
  ON "server_domain_operations" ("workspace_id", "server_id");
CREATE INDEX "server_domain_operations_workspace_id_status_idx"
  ON "server_domain_operations" ("workspace_id", "status");

ALTER TABLE "server_domain_operations"
  ADD CONSTRAINT "server_domain_operations_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "server_domain_operations"
  ADD CONSTRAINT "server_domain_operations_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "server_domain_operations"
  ADD CONSTRAINT "server_domain_operations_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Aynı sunucuda aynı anda yalnızca tek bir işlem yürüyebilir.
CREATE UNIQUE INDEX "server_domain_operations_one_running_per_server"
  ON "server_domain_operations" ("server_id")
  WHERE "status" IN ('pending', 'running');

-- Kiracı sınırı: sunucu referansları da aynı workspace içinde kalmak zorunda.
ALTER TABLE "servers"
  ADD CONSTRAINT "servers_workspace_id_id_key" UNIQUE ("workspace_id", "id");

ALTER TABLE "domains"
  ADD CONSTRAINT "domains_workspace_server_guard"
  FOREIGN KEY ("workspace_id", "server_id")
  REFERENCES "servers" ("workspace_id", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "server_domain_operations"
  ADD CONSTRAINT "server_domain_operations_workspace_server_guard"
  FOREIGN KEY ("workspace_id", "server_id")
  REFERENCES "servers" ("workspace_id", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- CreateTable
CREATE TABLE "configs" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_key" ON "configs"("key");

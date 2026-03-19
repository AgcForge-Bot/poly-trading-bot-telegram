-- CreateTable
CREATE TABLE "user_positions" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "slug" TEXT,
    "icon" TEXT,
    "proxyWallet" TEXT,
    "assets" TEXT,
    "conditionId" TEXT,
    "size" DOUBLE PRECISION,
    "avgPrice" DOUBLE PRECISION,
    "initialValue" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION,
    "cashPnl" DOUBLE PRECISION,
    "percentPnl" DOUBLE PRECISION,
    "totalBought" DOUBLE PRECISION,
    "realizedPnl" DOUBLE PRECISION,
    "percentRealizedPnl" DOUBLE PRECISION,
    "curPrice" DOUBLE PRECISION,
    "redeemable" BOOLEAN NOT NULL DEFAULT false,
    "mergeable" BOOLEAN NOT NULL DEFAULT false,
    "eventSlug" TEXT,
    "outcome" TEXT,
    "outcomeIndex" INTEGER,
    "oppositeOutcome" TEXT,
    "oppositeAsset" TEXT,
    "endDate" TIMESTAMP(3),
    "negativeRisk" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_activities" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "slug" TEXT,
    "icon" TEXT,
    "name" TEXT,
    "eventSlug" TEXT,
    "proxyWallet" TEXT,
    "conditionId" TEXT,
    "type" TEXT,
    "size" DOUBLE PRECISION,
    "usdcSize" DOUBLE PRECISION,
    "transactionHash" TEXT,
    "price" DOUBLE PRECISION,
    "asset" TEXT,
    "side" TEXT,
    "outcomeIndex" INTEGER,
    "outcome" TEXT,
    "pseudonym" TEXT,
    "bio" TEXT,
    "profileImage" TEXT,
    "profileImageOptimized" TEXT,
    "bot" BOOLEAN NOT NULL DEFAULT false,
    "botExcutedTime" INTEGER,
    "myBoughtSize" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_initialValue" ON "user_positions"("initialValue");

-- CreateIndex
CREATE INDEX "idx_currentValue" ON "user_positions"("currentValue");

-- CreateIndex
CREATE INDEX "idx_outcomeIndex" ON "user_positions"("outcomeIndex");

-- CreateIndex
CREATE INDEX "idx_slug" ON "user_activities"("slug");

-- CreateIndex
CREATE INDEX "idx_title" ON "user_activities"("title");

-- CreateIndex
CREATE INDEX "idx_proxyWallet" ON "user_activities"("proxyWallet");

-- CreateIndex
CREATE INDEX "idx_conditionId" ON "user_activities"("conditionId");

-- CreateIndex
CREATE INDEX "idx_userPositions_title" ON "user_positions"("title");

-- CreateIndex
CREATE INDEX "idx_userPositions_slug" ON "user_positions"("slug");

-- CreateIndex
CREATE INDEX "idx_assets" ON "user_positions"("assets");

-- CreateIndex
CREATE INDEX "idx_userPositions_proxyWallet" ON "user_positions"("proxyWallet");

-- CreateIndex
CREATE INDEX "idx_userPositions_conditionId" ON "user_positions"("conditionId");

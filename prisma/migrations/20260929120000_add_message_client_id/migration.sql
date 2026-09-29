ALTER TABLE "Message" ADD COLUMN "clientId" TEXT;

CREATE UNIQUE INDEX "Message_conversationId_senderId_clientId_key"
ON "Message"("conversationId", "senderId", "clientId");

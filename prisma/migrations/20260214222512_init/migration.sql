-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "rawQuery" TEXT NOT NULL,
    "parsedSpec" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "unitPrice" DOUBLE PRECISION,
    "moq" TEXT,
    "leadTimeDays" INTEGER,
    "shipping" TEXT,
    "terms" TEXT,
    "confidence" INTEGER,
    "source" TEXT NOT NULL,
    "rawEvidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "conversationId" TEXT,
    "transcript" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "duration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Call_conversationId_key" ON "Call"("conversationId");

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

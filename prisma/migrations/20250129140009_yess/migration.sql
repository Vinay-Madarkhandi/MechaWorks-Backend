/*
  Warnings:

  - A unique constraint covering the columns `[signature]` on the table `Task` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Task_signature_key" ON "Task"("signature");

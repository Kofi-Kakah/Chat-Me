/**
 * Diagnostic probe: verifies Prisma interactive transactions against the
 * linked Neon branch over the pooled and direct (unpooled) endpoints.
 * Run: npx tsx scripts/probe-tx.ts
 */
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "warn";

async function main(): Promise<void> {
  console.log("probe starting", new Date().toISOString());
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("../generated/prisma/client");

  const urls: Array<{ label: string; url: string }> = [];
  if (process.env.DATABASE_URL) urls.push({ label: "POOLED", url: process.env.DATABASE_URL });
  if (process.env.DATABASE_URL_UNPOOLED) {
    urls.push({ label: "UNPOOLED", url: process.env.DATABASE_URL_UNPOOLED });
  }

  for (const entry of urls) {
    console.log(`\n=== ${entry.label} ===`);
    const adapter = new PrismaPg({ connectionString: entry.url });
    const prisma = new PrismaClient({ adapter });

    // Control: plain query without a transaction.
    const t0 = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1 AS ok`;
      console.log(`  plain SELECT 1 OK in ${Date.now() - t0}ms`);
    } catch (error) {
      console.error(`  plain query FAILED:`, error);
      await prisma.$disconnect().catch(() => undefined);
      continue;
    }

    // Interactive transaction with a watchdog so we never hang the probe.
    const t1 = Date.now();
    const txPromise = prisma.$transaction(
      async (tx) => {
        const stamp = Date.now().toString(36);
        const user = await tx.user.create({
          data: {
            email: `probe_${stamp}@example.test`,
            username: `probe_${stamp}`,
            passwordHash: "probe",
          },
        });
        const conversation = await tx.conversation.create({
          data: { type: "DIRECT", directKey: `probe_${stamp}`, updatedAt: new Date() },
        });
        const message = await tx.message.create({
          data: { conversationId: conversation.id, senderId: user.id, body: "probe" },
        });
        await tx.messageRead.createMany({ data: [{ messageId: message.id, userId: user.id }] });
        await tx.notification.create({
          data: { userId: user.id, type: "MESSAGE", messageId: message.id },
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        });
        return { messageId: message.id, conversationId: conversation.id, userId: user.id };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    const watchdog = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 45_000),
    );
    const outcome = await Promise.race([
      txPromise.then(
        (value) => ({ kind: "ok" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      watchdog.then((kind) => ({ kind })),
    ]);

    if (outcome.kind === "ok") {
      console.log(`  interactive TX OK in ${Date.now() - t1}ms`, outcome.value);
      await prisma.conversation.deleteMany({ where: { directKey: { startsWith: "probe_" } } });
      await prisma.user.deleteMany({ where: { username: { startsWith: "probe_" } } });
      console.log("  cleanup OK");
    } else if (outcome.kind === "failed") {
      console.error(`  interactive TX FAILED after ${Date.now() - t1}ms:`, outcome.error);
    } else {
      console.error(`  interactive TX STILL RUNNING after 45s — treating as HANG`);
    }

    await prisma.$disconnect().catch(() => undefined);
  }
  console.log("\nprobe done");
  process.exit(0);
}


void main();

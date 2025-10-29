const { Storage } = require("@tenderly/actions");

const cleanupOldRecords = async (context) => {
  const storage = context.storage;

  console.log("[CLEANUP] Starting cleanup of old records");

  // This is a simple version - in production you'd want to track keys more systematically
  // For now, we rely on TTL to auto-expire records

  // Clean up the pending index of any stale entries
  try {
    const pendingIndex = await storage.getJson("cctp:pending-index");

    if (pendingIndex && Array.isArray(pendingIndex.burns)) {
      const originalCount = pendingIndex.burns.length;
      const stillValid = [];

      // Check each pending burn to see if it still exists
      for (const entry of pendingIndex.burns) {
        try {
          const burnData = await storage.getJson(entry.key);
          if (burnData) {
            stillValid.push(entry);
          } else {
            console.log(`[CLEANUP] Removing stale index entry: ${entry.key}`);
          }
        } catch (error) {
          // Record doesn't exist, skip it
          console.log(`[CLEANUP] Removing missing entry: ${entry.key}`);
        }
      }

      if (stillValid.length !== originalCount) {
        await storage.putJson(
          "cctp:pending-index",
          { burns: stillValid },
          { ttl: 604800 },
        );
        console.log(
          `[CLEANUP] Index cleaned: ${originalCount} -> ${stillValid.length}`,
        );
      } else {
        console.log(`[CLEANUP] No stale entries found in index`);
      }
    }
  } catch (error) {
    console.error(`[CLEANUP] ERROR: ${error.message}`);
  }

  console.log("[CLEANUP] Cleanup complete");
};

module.exports = { cleanupOldRecords };

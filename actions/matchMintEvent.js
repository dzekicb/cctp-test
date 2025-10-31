const { Storage } = require("@tenderly/actions");
const { ethers } = require("ethers");

const MESSAGE_RECEIVED_ABI = [
  "event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)",
];

const DOMAIN_TO_CHAIN = {
  0: "ethereum",
  1: "avalanche",
  2: "optimism",
  3: "arbitrum",
  5: "solana",
  6: "base",
  7: "polygon",
  10: "unichain",
  11: "linea",
  12: "codex",
  13: "sonic",
  14: "worldchain",
  16: "sei",
  17: "bnb",
  18: "xdc",
  19: "hyperevm",
  21: "ink",
  22: "plume",
  26: "arc-testnet",
};

const CHAIN_ID_MAP = {
  1: "ethereum",
  43114: "avalanche",
  10: "optimism",
  42161: "arbitrum",
  8453: "base",
  137: "polygon",
  130: "unichain",
  59144: "linea",
  146: "sonic",
  480: "worldchain",
  1329: "sei",
  56: "bnb",
  50: "xdc",
  57073: "ink",
  98866: "plume",
};

const matchMintEvent = async (context, event) => {
  const storage = context.storage;
  const TARGET_ADDRESS = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";

  console.log(`[MINT] Processing transaction: ${event.hash}`);
  console.log(
    `[MINT] Network: ${CHAIN_ID_MAP[event.network] || event.network} (${event.network}), Block: ${event.blockNumber}`,
  );
  console.log(`[MINT] Total logs in tx: ${event.logs ? event.logs.length : 0}`);

  const targetLog = event.logs.find(
    (log) => log.address?.toLowerCase() === TARGET_ADDRESS.toLowerCase(),
  );

  if (!targetLog) {
    console.log("[MINT] ERROR: No MessageReceived event found");
    console.log(`[MINT] Looking for MessageTransmitter at: ${TARGET_ADDRESS}`);
    console.log(`[MINT] Available log addresses: ${event.logs.map(l => l.address).slice(0, 5).join(", ")}`);
    return;
  }
  console.log(`[MINT] Found MessageReceived log at ${targetLog.address}`);

  let decoded;
  try {
    const iface = new ethers.Interface(MESSAGE_RECEIVED_ABI);
    decoded = iface.parseLog({
      topics: targetLog.topics,
      data: targetLog.data,
    });
  } catch (decodeError) {
    console.error(`[MINT] ERROR: Decode failed: ${decodeError.message}`);
    return;
  }

  const {
    caller,
    sourceDomain,
    nonce,
    sender,
    finalityThresholdExecuted,
    messageBody,
  } = decoded.args;
  // In CCTP, MessageReceived.nonce IS the messageHash (keccak256 of MessageSent.message)
  // According to spec: MessageReceived(bytes32 indexed messageHash) - the nonce parameter contains messageHash
  const nonceHex = (typeof nonce === "string" ? nonce : ethers.hexlify(nonce)).toLowerCase();
  console.log(`[MINT] MessageReceived.nonce (this IS the messageHash): ${nonceHex}`);

  const sourceChain = DOMAIN_TO_CHAIN[Number(sourceDomain)];
  const destChain = CHAIN_ID_MAP[event.network] || `chain-${event.network}`;

  if (!sourceChain) {
    console.warn(`[MINT] WARNING: Unknown source domain ${sourceDomain}`);
    return;
  }

  // Skip and track unsupported source chains (not available on Tenderly)
  const unsupportedSourceChains = new Set([
    "solana",
    "hyperevm",
    "codex",
    "xdc",
    "arc-testnet",
  ]);
  if (unsupportedSourceChains.has(sourceChain)) {
    console.log(
      `[MINT] Skipping | Source unsupported on Tenderly | ${sourceChain} -> ${destChain} | MsgHash: ${nonceHex}`,
    );
    try {
      const statKey = `cctp:stats:unsupported_source:${sourceChain}`;
      const existing = (await storage.getJson(statKey)) || { count: 0 };
      await storage.putJson(
        statKey,
        { count: (existing.count || 0) + 1, lastSeen: Math.floor(Date.now() / 1000) },
        { ttl: 2592000 },
      );
    } catch (_) {}
    return;
  }

  const trackingKey = `cctp:burn:${sourceChain}:${nonceHex}`;
  console.log(
    `[MINT] Looking for burn | MsgHash: ${nonceHex} | ${sourceChain} -> ${destChain}`,
  );
  console.log(`[MINT] Lookup key: ${trackingKey}`);
  console.log(`[MINT] This key should match burn storage: cctp:burn:${sourceChain}:<messageHash from MessageSent>`);

  let burnData;
  let burnFound = false;
  try {
    const retrieved = await storage.getJson(trackingKey);
    // Tenderly storage.getJson() returns {} when key doesn't exist (not an error)
    // So we must check if it's truly empty vs a real record
    if (retrieved && typeof retrieved === "object") {
      const keys = Object.keys(retrieved);
      if (keys.length > 0) {
        // Valid record with data
        burnData = retrieved;
        burnFound = true;
        console.log(`[MINT] Burn record found at key: ${trackingKey} | Fields: ${keys.length} | Type: ${retrieved.transferType || "unknown"}`);
      } else {
        // Empty object {} means key doesn't exist (Tenderly quirk)
        console.log(`[MINT] No burn record found (empty object {} = key doesn't exist)`);
        burnFound = false;
      }
    } else {
      // Not an object or null - key doesn't exist
      console.log(`[MINT] No burn record found (not an object)`);
      burnFound = false;
    }
  } catch (error) {
    // Error reading - key doesn't exist or storage error
    console.log(`[MINT] No burn record found (error: ${error && error.message ? error.message : "key doesn't exist"})`);
    burnFound = false;
  }
  
  if (!burnFound) {
    console.log(`[MINT] Burn record not found - this could mean:`);
    console.log(`[MINT]   1. Burn hasn't occurred yet (timing issue)`);
    console.log(`[MINT]   2. Burn action didn't trigger/capture this transfer`);
    console.log(`[MINT]   3. MessageHash mismatch (burn stored with different hash)`);
  }

  const currentTimestamp = Math.floor(Date.now() / 1000);

  // Validate burn data - check required fields
  const requiredFields = {
    nonce: burnData?.nonce,
    sourceChain: burnData?.sourceChain,
    amount: burnData?.amount,
  };
  const missingFields = Object.entries(requiredFields)
    .filter(([key, value]) => !value)
    .map(([key]) => key);
  const hasBurnData = burnFound && missingFields.length === 0;

  if (hasBurnData) {
    let duration = null;
    if (burnData.burnTimestamp) {
      duration = currentTimestamp - burnData.burnTimestamp;
      console.log(`[MINT] Match found | Duration: ${duration}s`);
    } else {
      console.log(`[MINT] Match found`);
    }

    const completeTransfer = {
      nonce: burnData.nonce,
      messageHash: burnData.messageHash || nonceHex,
      sourceChain: burnData.sourceChain,
      sourceChainId: burnData.sourceChainId,
      sourceTxHash: burnData.sourceTxHash,
      sourceBlockNumber: burnData.sourceBlockNumber,
      burnToken: burnData.burnToken,
      amount: burnData.amount,
      depositor: burnData.depositor,
      mintRecipient: burnData.mintRecipient,
      destinationDomain: burnData.destinationDomain,
      destinationChain: destChain,
      destinationChainId: event.network,
      destinationTxHash: event.hash,
      destinationBlockNumber: event.blockNumber,
      destinationTokenMessenger: burnData.destinationTokenMessenger,
      destinationCaller: burnData.destinationCaller,
      maxFee: burnData.maxFee,
      minFinalityThreshold: burnData.minFinalityThreshold,
      transferType: burnData.transferType || "unknown", // Preserve transfer type from burn
      hookData: burnData.hookData,
      burnTimestamp: burnData.burnTimestamp,
      mintTimestamp: currentTimestamp,
      messageReceived: {
        caller,
        sender,
        finalityThresholdExecuted: finalityThresholdExecuted.toString(),
      },
      status: "completed",
      durationSeconds: duration,
    };

    const completedKey = `cctp:completed:${sourceChain}:${nonceHex}`;

    try {
      await storage.putJson(completedKey, completeTransfer, { ttl: 2592000 });
      await storage.delete(trackingKey);
      console.log(`[MINT] Success | Type: ${completeTransfer.transferType} | Completed in ${duration}s`);
      console.log(`[MINT] Created completed record: ${completedKey}`);
      
      // Verify the completed record was written
      try {
        const verify = await storage.getJson(completedKey);
        if (verify && Object.keys(verify).length > 0) {
          console.log(`[MINT] Verified completed record exists with ${Object.keys(verify).length} fields`);
        } else {
          console.error(`[MINT] ERROR: Completed record write verification failed - read back empty`);
        }
      } catch (verifyErr) {
        console.error(`[MINT] ERROR: Could not verify completed record: ${verifyErr && verifyErr.message ? verifyErr.message : String(verifyErr)}`);
      }
    } catch (storageError) {
      console.error(`[MINT] ERROR: Storage failed: ${storageError.message}`);
      console.error(`[MINT] Failed to create completed record: ${completedKey}`);
    }
  } else {
    // Orphaned or corrupt
    if (burnFound && burnData) {
      // We found a record but it's missing required fields - this is true corruption
      const keys = Object.keys(burnData || {});
      console.warn(`[MINT] ALERT: Corrupt burn data - missing required fields: ${missingFields.join(", ")}`);
      console.warn(`[MINT] Present fields: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ` ... (${keys.length} total)` : ""}`);
      console.warn(`[MINT] Corrupt data sample: ${JSON.stringify(burnData).substring(0, 300)}`);
      
      try {
        await storage.delete(trackingKey);
        console.log(`[MINT] Deleted corrupt key: ${trackingKey}`);
      } catch (e) {
        console.error(`[MINT] Failed to delete corrupt key: ${e && e.message ? e.message : String(e)}`);
      }
    }
    // If burnFound=false, no burn record exists (either empty object {} from getJson means doesn't exist, or error reading)

    console.warn(
      `[MINT] ALERT: Orphaned mint | ${sourceChain} -> ${destChain} | MsgHash: ${nonceHex}`,
    );

    // Use timestamp in key to avoid collisions on nonce 0 or large nonces
    // Include nonce to ensure uniqueness and avoid potential same-second collisions
    const orphanedKey = `cctp:orphaned:${destChain}:${nonceHex}:${currentTimestamp}`;
    const orphanedIndexKey = `cctp:orphanedIndex:${sourceChain}:${nonceHex}`;

    const orphanedData = {
      destinationChain: destChain,
      destinationChainId: event.network.toString(),
      destinationTxHash: event.hash,
      destinationBlockNumber: event.blockNumber.toString(),
      nonce: burnData && burnData.nonce ? burnData.nonce : undefined,
      messageHash: nonceHex,
      sourceDomain: sourceDomain.toString(),
      sourceChain,
      mintTimestamp: currentTimestamp,
      callerAddress: caller,
      senderBytes32: sender,
      finalityThreshold: finalityThresholdExecuted.toString(),
      status: "orphaned",
      reason: burnData ? "corrupt_burn_data" : "no_burn_data",
    };

    try {
      const payloadSize = JSON.stringify(orphanedData).length;
      console.log(`[MINT] Orphaned payload size: ${payloadSize} bytes, key: ${orphanedKey}`);
      await storage.putJson(orphanedKey, orphanedData, { ttl: 604800 });
      // Deterministic index for reconciliation by burn arrival (minimal payload)
      await storage.putJson(
        orphanedIndexKey,
        { pointer: orphanedKey, createdAt: currentTimestamp, src: sourceChain, dst: destChain },
        { ttl: 604800 },
      );
      console.log(`[MINT] Stored orphaned mint data`);

      const webhookUrl = await context.secrets.get("WEBHOOK_URL");
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "orphaned_mint_alert",
            severity: "warning",
            message: `Orphaned mint: no matching burn for messageHash ${nonceHex}`,
            ...orphanedData,
          }),
        });
        console.log(`[MINT] Alert sent`);
      }
    } catch (error) {
      console.error(`[MINT] ERROR: Failed to store orphaned mint: ${error && error.message ? error.message : String(error)}`);
      try {
        console.error(`[MINT] Error details: ${JSON.stringify(error)}`);
      } catch (_) {}
      console.error(`[MINT] Orphaned data:`, JSON.stringify(orphanedData));

      // Fallback: try storing a minimal record to isolate payload issues
      try {
        const minimalKey = `${orphanedKey}:min`;
        const minimal = {
          destinationChain: destChain,
          destinationChainId: String(event.network),
          destinationTxHash: event.hash,
          messageHash: nonceHex,
          sourceDomain: sourceDomain.toString(),
          sourceChain,
          status: "orphaned",
          lastTried: currentTimestamp,
        };
        await storage.putJson(minimalKey, minimal, { ttl: 604800 });
        console.log(`[MINT] Stored minimal orphaned record for diagnostics`);
      } catch (fallbackError) {
        console.error(`[MINT] Fallback store failed: ${fallbackError && fallbackError.message ? fallbackError.message : String(fallbackError)}`);
      }
    }
  }
};

module.exports = { matchMintEvent };

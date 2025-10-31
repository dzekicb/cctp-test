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

  const targetLog = event.logs.find(
    (log) => log.address?.toLowerCase() === TARGET_ADDRESS.toLowerCase(),
  );

  if (!targetLog) {
    console.log("[MINT] ERROR: No MessageReceived event found");
    return;
  }

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
  const nonceValue = BigInt(nonce);

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
      `[MINT] Skipping | Source unsupported on Tenderly | ${sourceChain} -> ${destChain} | Nonce: ${nonceValue}`,
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

  const trackingKey = `cctp:burn:${sourceChain}:${nonceValue}`;
  console.log(
    `[MINT] Looking for burn | Nonce: ${nonceValue} | ${sourceChain} -> ${destChain}`,
  );

  let burnData;
  try {
    burnData = await storage.getJson(trackingKey);
  } catch (error) {
    // Burn data not found
  }

  const currentTimestamp = Math.floor(Date.now() / 1000);

  // Validate burn data
  const hasBurnData =
    burnData && burnData.nonce && burnData.sourceChain && burnData.amount;

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

    const completedKey = `cctp:completed:${sourceChain}:${nonceValue}`;

    try {
      await storage.putJson(completedKey, completeTransfer, { ttl: 2592000 });
      await storage.delete(trackingKey);
      console.log(`[MINT] Success | Completed in ${duration}s`);
    } catch (storageError) {
      console.error(`[MINT] ERROR: Storage failed: ${storageError.message}`);
    }
  } else {
    // Orphaned or corrupt
    if (burnData) {
      console.warn(`[MINT] ALERT: Corrupt burn data, deleting`);
      try {
        await storage.delete(trackingKey);
      } catch (e) {}
    }

    console.warn(
      `[MINT] ALERT: Orphaned mint | ${sourceChain} -> ${destChain} | Nonce: ${nonceValue}`,
    );

    // Use timestamp in key to avoid collisions on nonce 0 or large nonces
    const orphanedKey = `cctp:orphaned:${destChain}:${currentTimestamp}`;

    const orphanedData = {
      destinationChain: destChain,
      destinationChainId: event.network.toString(),
      destinationTxHash: event.hash,
      destinationBlockNumber: event.blockNumber.toString(),
      nonce: nonceValue.toString(),
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
      await storage.putJson(orphanedKey, orphanedData, { ttl: 604800 });
      console.log(`[MINT] Stored orphaned mint data`);

      const webhookUrl = await context.secrets.get("WEBHOOK_URL");
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "orphaned_mint_alert",
            severity: "warning",
            message: `Orphaned mint: no matching burn for nonce ${nonceValue}`,
            ...orphanedData,
          }),
        });
        console.log(`[MINT] Alert sent`);
      }
    } catch (error) {
      console.error(
        `[MINT] ERROR: Failed to store orphaned mint: ${error.message}`,
      );
      console.error(`[MINT] Orphaned data:`, JSON.stringify(orphanedData));
    }
  }
};

module.exports = { matchMintEvent };

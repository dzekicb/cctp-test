const { Storage } = require("@tenderly/actions");
const { ethers } = require("ethers");

const DEPOSIT_FOR_BURN_ABI = [
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
];

const MESSAGE_SENT_ABI = ["event MessageSent(bytes message)"];

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

const storeBurnEvent = async (context, event) => {
  const storage = context.storage;
  const TOKEN_MESSENGER_ADDRESS = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d";
  const MESSAGE_TRANSMITTER_ADDRESS =
    "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";

  console.log(`[BURN] Processing transaction: ${event.hash}`);
  console.log(
    `[BURN] Network: ${CHAIN_ID_MAP[event.network] || event.network} (${event.network}), Block: ${event.blockNumber}`,
  );
  console.log(`[BURN] Total logs in tx: ${event.logs ? event.logs.length : 0}`);

  const burnLog = event.logs.find(
    (log) =>
      log.address?.toLowerCase() === TOKEN_MESSENGER_ADDRESS.toLowerCase(),
  );

  if (!burnLog) {
    console.log("[BURN] ERROR: No DepositForBurn event found");
    console.log(`[BURN] Available log addresses: ${event.logs.map(l => l.address).slice(0, 5).join(", ")}`);
    return;
  }
  console.log(`[BURN] Found DepositForBurn log at ${burnLog.address}`);

  let burnDecoded;
  try {
    const burnIface = new ethers.Interface(DEPOSIT_FOR_BURN_ABI);
    burnDecoded = burnIface.parseLog({
      topics: burnLog.topics,
      data: burnLog.data,
    });
  } catch (decodeError) {
    console.error(`[BURN] ERROR: Decode failed: ${decodeError.message}`);
    return;
  }

  const {
    burnToken,
    amount,
    depositor,
    mintRecipient,
    destinationDomain,
    destinationTokenMessenger,
    destinationCaller,
    maxFee,
    minFinalityThreshold,
    hookData,
  } = burnDecoded.args;

  const messageIface = new ethers.Interface(MESSAGE_SENT_ABI);
  const candidateLogs = event.logs.filter(
    (log) =>
      log.address?.toLowerCase() === MESSAGE_TRANSMITTER_ADDRESS.toLowerCase(),
  );

  if (!candidateLogs || candidateLogs.length === 0) {
    console.log("[BURN] ERROR: No MessageSent event found");
    console.log(`[BURN] Looking for MessageTransmitter at: ${MESSAGE_TRANSMITTER_ADDRESS}`);
    return;
  }
  console.log(`[BURN] Found ${candidateLogs.length} MessageSent candidate(s)`);

  // Choose the MessageSent whose header destDomain matches the burn's destinationDomain
  let messageBytes;
  let matchedHeader = null;
  for (const log of candidateLogs) {
    try {
      const decoded = messageIface.parseLog({ topics: log.topics, data: log.data });
      const msg = decoded.args.message;
      const bytes = ethers.getBytes(msg);
      if (bytes.length >= 12) {
        const view = new DataView(new Uint8Array(bytes.slice(0, 12)).buffer);
        const ver = view.getUint32(0, false);
        const srcDom = view.getUint32(4, false);
        const dstDom = view.getUint32(8, false);
        if (String(dstDom) === destinationDomain.toString()) {
          messageBytes = msg;
          matchedHeader = { ver, srcDom, dstDom };
          break;
        }
      }
    } catch (_) {
      // try next
    }
  }

  // Fallback to first decodable if no header match
  if (!messageBytes) {
    try {
      const fallback = messageIface.parseLog({
        topics: candidateLogs[0].topics,
        data: candidateLogs[0].data,
      });
      messageBytes = fallback.args.message;
      const bytes = ethers.getBytes(messageBytes);
      if (bytes.length >= 12) {
        const view = new DataView(new Uint8Array(bytes.slice(0, 12)).buffer);
        matchedHeader = {
          ver: view.getUint32(0, false),
          srcDom: view.getUint32(4, false),
          dstDom: view.getUint32(8, false),
        };
      }
    } catch (e) {
      console.error(`[BURN] ERROR: Failed to decode any MessageSent: ${e.message}`);
      return;
    }
  }

  const messageHash = ethers.keccak256(messageBytes).toLowerCase();

  // Parse message structure to extract nonce safely from bytes
  // Format: version(4) + sourceDomain(4) + destDomain(4) + nonce(8) + ...
  let nonce = BigInt(0);
  try {
    const msgBytes = ethers.getBytes(messageBytes);
    // Log header for diagnostics
    if (matchedHeader) {
      console.log(
        `[BURN] Message header | version=${matchedHeader.ver} sourceDomain=${matchedHeader.srcDom} destDomain=${matchedHeader.dstDom}`,
      );
    } else if (msgBytes.length >= 12) {
      const dvHead = new DataView(new Uint8Array(msgBytes.slice(0, 12)).buffer);
      console.log(
        `[BURN] Message header | version=${dvHead.getUint32(0, false)} sourceDomain=${dvHead.getUint32(4, false)} destDomain=${dvHead.getUint32(8, false)}`,
      );
    }
    // Best-effort parse of uint64 nonce; many chains/messages may not include a uint64 nonce here.
    if (msgBytes.length >= 20) {
      const view = new DataView(new Uint8Array(msgBytes.slice(12, 20)).buffer);
      const high = view.getUint32(0, false);
      const low = view.getUint32(4, false);
      nonce = (BigInt(high) << 32n) + BigInt(low);
    }
  } catch (e) {
    console.warn(`[BURN] WARNING: Failed to parse message bytes: ${e.message}`);
  }

  // Validate nonce was extracted correctly
  if (nonce === BigInt(0)) {
    console.warn(
      `[BURN] WARNING: Extracted nonce is 0, this may indicate parsing issue`,
    );
    console.warn(
      `[BURN] Message length: ${messageBytes.length}, First 100 chars: ${messageBytes.substring(0, 100)}`,
    );
  }

  const sourceChain = CHAIN_ID_MAP[event.network] || `chain-${event.network}`;
  const destChain =
    DOMAIN_TO_CHAIN[Number(destinationDomain)] || `domain-${destinationDomain}`;

  // Log correlation key for verification
  // MessageReceived.nonce (bytes32) IS this messageHash - they must match exactly
  console.log(`[BURN] MessageHash: ${messageHash}`);
  console.log(`[BURN] Mint will look for: cctp:burn:${sourceChain}:${messageHash}`);
  console.log(`[BURN] MessageReceived.nonce must equal this messageHash for match`);

  // Do not require a uint64 nonce. Use messageHash as the canonical key.

  // Skip and track unsupported destination chains (not available on Tenderly)
  const unsupportedDestChains = new Set([
    "solana",
    "hyperevm",
    "codex",
    "xdc",
    "arc-testnet",
  ]);
  if (unsupportedDestChains.has(destChain)) {
    console.log(
      `[BURN] Skipping | Destination unsupported on Tenderly | ${sourceChain} -> ${destChain} | Nonce: ${nonce}`,
    );
    try {
      const statKey = `cctp:stats:unsupported_dest:${destChain}`;
      const existing = (await storage.getJson(statKey)) || { count: 0 };
      await storage.putJson(
        statKey,
        { count: (existing.count || 0) + 1, lastSeen: Math.floor(Date.now() / 1000) },
        { ttl: 2592000 },
      );
    } catch (_) {}
    return;
  }

  const trackingKey = `cctp:burn:${sourceChain}:${messageHash}`;
  const currentTimestamp = Math.floor(Date.now() / 1000);

  // Detect transfer type: Fast Transfer uses minFinalityThreshold <= 1000
  // Reference: https://developers.circle.com/cctp/transfer-usdc-on-testnet-from-ethereum-to-avalanche
  const minFinality = Number(minFinalityThreshold);
  const transferType = minFinality <= 1000 ? "fast" : "standard";

  const burnData = {
    nonce: nonce.toString(),
    messageHash,
    sourceChain,
    sourceChainId: event.network,
    sourceTxHash: event.hash,
    sourceBlockNumber: event.blockNumber,
    burnToken,
    amount: amount.toString(),
    depositor,
    mintRecipient,
    destinationDomain: destinationDomain.toString(),
    destinationChain: destChain,
    destinationTokenMessenger,
    destinationCaller,
    maxFee: maxFee.toString(),
    minFinalityThreshold: minFinalityThreshold.toString(),
    transferType, // "fast" or "standard"
    hookData: hookData,
    burnTimestamp: currentTimestamp,
    status: "pending",
  };

  console.log(
    `[BURN] Storing | Type: ${transferType} | Nonce: ${nonce} | ${sourceChain} -> ${destChain} | Amount: ${amount.toString()} | FinalityThreshold: ${minFinality}`,
  );

  // Validate burnData before storing (prevent empty object writes)
  const requiredFields = ["nonce", "messageHash", "sourceChain", "amount", "destinationDomain"];
  const missingFields = requiredFields.filter((f) => !burnData[f]);
  if (missingFields.length > 0) {
    console.error(`[BURN] ERROR: Cannot store - missing required fields: ${missingFields.join(", ")}`);
    console.error(`[BURN] burnData keys: ${Object.keys(burnData).join(", ")}`);
    return;
  }

  // Log what we're about to write
  const dataToStore = JSON.stringify(burnData);
  console.log(`[BURN] Writing ${Object.keys(burnData).length} fields, payload size: ${dataToStore.length} bytes`);
  if (dataToStore.length < 100) {
    console.warn(`[BURN] WARNING: Payload suspiciously small: ${dataToStore}`);
  }

  try {
    // Note: Tenderly storage.getJson() returns {} when key doesn't exist
    // So we can't distinguish "doesn't exist" from "empty object"
    // Just proceed - putJson will overwrite anyway

    // TTL: 7 days (604800s) - sufficient for longest attestation (Linea: ~32 hours max)
    // Most chains complete in seconds to minutes; this provides huge safety margin
    try {
      await storage.putJson(trackingKey, burnData, { ttl: 604800 });
    } catch (writeErr) {
      console.error(`[BURN] ERROR: putJson failed: ${writeErr && writeErr.message ? writeErr.message : String(writeErr)}`);
      console.error(`[BURN] Failed key: ${trackingKey}`);
      throw writeErr; // Re-throw to prevent continuing
    }
    
    // Verify write succeeded by reading back immediately
    try {
      // Small delay to account for eventual consistency
      await new Promise(resolve => setTimeout(resolve, 100));
      const verify = await storage.getJson(trackingKey);
      const verifyKeys = Object.keys(verify || {});
      if (verifyKeys.length === 0) {
        console.error(`[BURN] CRITICAL ERROR: Storage write failed - empty object written to ${trackingKey}`);
        console.error(`[BURN] Attempted to write ${Object.keys(burnData).length} fields: ${Object.keys(burnData).slice(0, 10).join(", ")}`);
        console.error(`[BURN] MessageHash: ${messageHash} | Source: ${sourceChain} | Dest: ${destChain}`);
        console.error(`[BURN] Read back: ${JSON.stringify(verify)}`);
        console.error(`[BURN] This is a Tenderly storage issue - putJson succeeded but wrote empty object`);
        // Try deleting the corrupt key
        try {
          await storage.delete(trackingKey);
          console.log(`[BURN] Deleted corrupt empty key: ${trackingKey}`);
        } catch (delErr) {
          console.error(`[BURN] Failed to delete corrupt key: ${delErr && delErr.message ? delErr.message : String(delErr)}`);
        }
        return;
      }
      if (verifyKeys.length !== Object.keys(burnData).length) {
        console.warn(`[BURN] WARNING: Field count mismatch - wrote ${Object.keys(burnData).length}, read ${verifyKeys.length}`);
      }
      console.log(`[BURN] Success | Key: ${trackingKey} | TTL: 7 days | Verified: ${verifyKeys.length} fields stored`);
    } catch (verifyErr) {
      console.error(`[BURN] ERROR: Could not verify storage write: ${verifyErr && verifyErr.message ? verifyErr.message : String(verifyErr)}`);
      // Continue anyway - storage might be eventually consistent
      console.log(`[BURN] Success | Key: ${trackingKey} | TTL: 7 days | (verification failed)`);
    }

    // Reconciliation path: if a mint arrived first, complete now using orphaned index
    try {
      const orphanedIndexKey = `cctp:orphanedIndex:${sourceChain}:${messageHash}`;
      const orphanedIndex = await storage.getJson(orphanedIndexKey).catch(() => null);
      if (orphanedIndex && orphanedIndex.pointer) {
        const completedKey = `cctp:completed:${sourceChain}:${messageHash}`;
        const destChainIdFromName = event.network; // destinationChainId will be set by matcher normally
        const completed = {
          nonce: burnData.nonce,
          messageHash: messageHash,
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
          destinationChainId: null,
          destinationTxHash: null,
          destinationBlockNumber: null,
          destinationTokenMessenger: burnData.destinationTokenMessenger,
          destinationCaller: burnData.destinationCaller,
          maxFee: burnData.maxFee,
          minFinalityThreshold: burnData.minFinalityThreshold,
          transferType: burnData.transferType || "unknown",
          hookData: burnData.hookData,
          burnTimestamp: burnData.burnTimestamp,
          mintTimestamp: null,
          status: "pending-mint",
        };
        await storage.putJson(completedKey, completed, { ttl: 2592000 });
        // cleanup orphaned artifacts
        await storage.delete(orphanedIndexKey).catch(() => {});
        await storage.delete(orphanedIndex.pointer).catch(() => {});
        console.log(`[BURN] Reconciled orphaned mint via index for ${messageHash}`);
      }
    } catch (reconErr) {
      console.log(`[BURN] Reconcile check skipped/failed: ${reconErr && reconErr.message ? reconErr.message : String(reconErr)}`);
    }
  } catch (storageError) {
    console.error(`[BURN] ERROR: Storage failed: ${storageError.message}`);
  }
};

module.exports = { storeBurnEvent };

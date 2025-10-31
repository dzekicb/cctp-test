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
  const burnLogIndex = event.logs.findIndex(log => 
    log.address?.toLowerCase() === TOKEN_MESSENGER_ADDRESS.toLowerCase()
  );
  console.log(`[BURN] Found DepositForBurn log at ${burnLog.address}, log index: ${burnLogIndex}`);

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
  
  // Log DepositForBurn details for correlation
  console.log(`[BURN] DepositForBurn extracted: amount=${amount.toString()}, destDomain=${destinationDomain.toString()}, minFinality=${minFinalityThreshold.toString()}`);
  console.log(`[BURN] burnToken=${burnToken}, depositor=${depositor}, mintRecipient=${ethers.hexlify(mintRecipient)}`);

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
  // CRITICAL: Must also match sourceDomain to current chain to avoid picking wrong MessageSent
  let messageBytes;
  let matchedHeader = null;
  
  // Build reverse mapping: chain name -> domain for validation
  const chainToDomain = {};
  Object.entries(DOMAIN_TO_CHAIN).forEach(([domain, chain]) => {
    chainToDomain[chain] = Number(domain);
  });
  const currentChainName = CHAIN_ID_MAP[event.network] || `chain-${event.network}`;
  const expectedSourceDomain = chainToDomain[currentChainName];
  
  console.log(`[BURN] Looking for MessageSent with destDomain=${destinationDomain}`);
  if (expectedSourceDomain !== undefined) {
    console.log(`[BURN] Current chain: ${currentChainName} (domain ${expectedSourceDomain})`);
    console.log(`[BURN] MessageSent MUST have: sourceDomain=${expectedSourceDomain} AND destDomain=${destinationDomain}`);
  }
  
  const matchingCandidates = [];
  const allCandidates = []; // Track ALL candidates for debugging
  for (let i = 0; i < candidateLogs.length; i++) {
    const log = candidateLogs[i];
    // Find the actual log index in the transaction
    let msgLogIndex = -1;
    for (let j = 0; j < event.logs.length; j++) {
      const txLog = event.logs[j];
      if (txLog.address?.toLowerCase() === log.address?.toLowerCase() &&
          txLog.topics && log.topics && 
          txLog.topics.length > 0 && log.topics.length > 0 &&
          txLog.topics[0] === log.topics[0]) {
        msgLogIndex = j;
        break;
      }
    }
    try {
      const decoded = messageIface.parseLog({ topics: log.topics, data: log.data });
      const msg = decoded.args.message;
      
      // CRITICAL: The message from ABI decoding might be in different format
      // Try multiple extraction methods to ensure we get raw bytes
      let bytes;
      let msgHex;
      
      if (typeof msg === "string") {
        // If it's already a hex string, use it directly
        bytes = ethers.getBytes(msg);
        msgHex = msg.toLowerCase().startsWith("0x") ? msg : "0x" + msg;
      } else {
        // If it's bytes/array, convert to hex
        bytes = msg;
        msgHex = ethers.hexlify(bytes);
      }
      
      // CRITICAL: Use the raw bytes directly for hashing (not the hex string)
      // ethers.keccak256 can accept both, but bytes might be more accurate
      const computedHash = ethers.keccak256(bytes).toLowerCase();
      
      // Store all candidates for full comparison
      const candidateInfo = {
        index: i,
        logIndex: msgLogIndex,
        message: msg,
        messageHex: msgHex,
        bytes,
        hash: computedHash,
        length: bytes.length
      };
      
      if (bytes.length >= 12) {
        const view = new DataView(new Uint8Array(bytes.slice(0, 12)).buffer);
        const ver = view.getUint32(0, false);
        const srcDom = view.getUint32(4, false);
        const dstDom = view.getUint32(8, false);
        const logProximity = msgLogIndex !== -1 ? Math.abs(msgLogIndex - burnLogIndex) : "unknown";
        
        candidateInfo.version = ver;
        candidateInfo.sourceDomain = srcDom;
        candidateInfo.destDomain = dstDom;
        candidateInfo.proximity = logProximity;
        
        console.log(`[BURN] MessageSent candidate #${i}: logIndex=${msgLogIndex}, proximityToBurn=${logProximity}, version=${ver}, sourceDomain=${srcDom} (${DOMAIN_TO_CHAIN[srcDom] || "unknown"}), destDomain=${dstDom} (${DOMAIN_TO_CHAIN[dstDom] || "unknown"})`);
        console.log(`[BURN]   Computed messageHash: ${computedHash}`);
        console.log(`[BURN]   Message length: ${bytes.length} bytes, first 64 hex: ${ethers.hexlify(bytes.slice(0, 32))}`);
        
        // Match BOTH sourceDomain (current chain) AND destDomain (burn destination)
        const destMatches = String(dstDom) === destinationDomain.toString();
        const srcMatches = expectedSourceDomain !== undefined ? srcDom === expectedSourceDomain : true;
        
        if (destMatches && srcMatches) {
          // Perfect match: both domains correct
          messageBytes = msg;
          matchedHeader = { ver, srcDom, dstDom };
          candidateInfo.selected = true;
          console.log(`[BURN] ✓ Perfect match selected: candidate #${i} (logIndex ${msgLogIndex}), messageHash=${computedHash}`);
          allCandidates.push(candidateInfo);
          break;
        } else if (destMatches) {
          // Only destDomain matches - log as candidate but don't use yet (fallback if no perfect match)
          candidateInfo.reason = `destDomain matches but sourceDomain ${srcDom} !== expected ${expectedSourceDomain}`;
          matchingCandidates.push({ 
            msg, 
            header: { ver, srcDom, dstDom }, 
            hash: computedHash,
            logIndex: msgLogIndex,
            proximity: logProximity,
            reason: candidateInfo.reason
          });
        }
      } else {
        console.warn(`[BURN] MessageSent candidate #${i}: message too short (${bytes.length} bytes, need at least 12)`);
      }
      
      allCandidates.push(candidateInfo);
    } catch (e) {
      console.warn(`[BURN] Failed to parse MessageSent candidate #${i}: ${e.message}`);
    }
  }
  
  // Log summary of all candidates
  if (allCandidates.length > 0) {
    console.log(`[BURN] SUMMARY: Found ${allCandidates.length} MessageSent event(s) total`);
    allCandidates.forEach((c, idx) => {
      console.log(`[BURN]   Candidate #${idx}: hash=${c.hash}, srcDom=${c.sourceDomain || "?"}, dstDom=${c.destDomain || "?"}, len=${c.length}, selected=${c.selected || false}`);
    });
  }
  
  // If no perfect match found but we have destDomain matches, warn and use closest one
  if (!messageBytes && matchingCandidates.length > 0) {
    console.warn(`[BURN] WARNING: No perfect match found, but found ${matchingCandidates.length} candidate(s) with matching destDomain`);
    // Prefer candidate closest to DepositForBurn log
    matchingCandidates.sort((a, b) => {
      if (typeof a.proximity === "number" && typeof b.proximity === "number") {
        return a.proximity - b.proximity;
      }
      return 0;
    });
    const selected = matchingCandidates[0];
    console.warn(`[BURN] Using closest destDomain match (logIndex ${selected.logIndex}, proximity ${selected.proximity}): ${selected.reason}`);
    console.warn(`[BURN] Selected messageHash: ${selected.hash}`);
    messageBytes = selected.msg;
    matchedHeader = selected.header;
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

  // CRITICAL: Based on MessageV2.sol source code analysis:
  // - _formatMessageForRelay() sets nonce to EMPTY_NONCE (bytes32(0)) when formatting
  // - _getNonce() extracts bytes 12-44 from message
  // - BUT MessageReceived.nonce is NOT the nonce from the message (it's zero)!
  // - MessageReceived.nonce IS keccak256(message) computed by attestation/relayer
  // This is the canonical identifier for the message
  const msgBytes = ethers.getBytes(messageBytes);
  const messageBytesHex = ethers.hexlify(msgBytes);
  
  // MessageReceived.nonce is keccak256 of the full message
  const messageHash = ethers.keccak256(messageBytesHex).toLowerCase();
  
  // Extract messageBody from MessageSent.message for correlation verification
  // MessageBody starts at byte 148 (MESSAGE_BODY_INDEX = 148)
  let messageBodyFromSent = null;
  if (msgBytes.length > 148) {
    const messageBodyBytes = msgBytes.slice(148);
    messageBodyFromSent = ethers.hexlify(messageBodyBytes).toLowerCase();
    console.log(`[BURN] Extracted messageBody (from byte 148): ${messageBodyFromSent.substring(0, 66)}...`);
    console.log(`[BURN] messageBody length: ${messageBodyBytes.length} bytes`);
  }
  
  // Also extract the nonce field from bytes 12-44 for logging (but it's zero)
  let nonceBytes32 = null;
  if (msgBytes.length >= 44) {
    const nonceBytes = msgBytes.slice(12, 44);
    nonceBytes32 = ethers.hexlify(nonceBytes).toLowerCase();
  }
  
  // Log message details for verification
  console.log(`[BURN] Message bytes length: ${msgBytes.length} bytes`);
  console.log(`[BURN] Nonce field from message (bytes 12-44): ${nonceBytes32} (expected: all zeros)`);
  console.log(`[BURN] Computed keccak256(message) for correlation: ${messageHash}`);
  console.log(`[BURN] MessageReceived.nonce IS keccak256(message) - this is the correlation key`);
  
  // Store messageBody for correlation verification on mint side
  // This allows us to verify that MessageReceived.messageBody matches what we sent

  // Parse message structure for logging (nonce already extracted above)
  // Message format (CCTP V2):
  //   version (4 bytes) = 0-3
  //   sourceDomain (4 bytes) = 4-7
  //   destinationDomain (4 bytes) = 8-11
  //   nonce (32 bytes, bytes32) = 12-43  <-- Already extracted above
  //   sender (32 bytes) = 44-75
  //   recipient (32 bytes) = 76-107
  //   destinationCaller (32 bytes) = 108-139
  //   minFinalityThreshold (4 bytes) = 140-143
  //   finalityThresholdExecuted (4 bytes) = 144-147
  //   messageBody (dynamic) = 148+
  
  // Also parse nonce as uint64 for backward compatibility/logging
  let nonce = BigInt(0);
  try {
    if (msgBytes.length >= 20) {
      // Parse first 8 bytes of nonce as uint64 (for logging, but nonceBytes32 is the real key)
      const view = new DataView(new Uint8Array(msgBytes.slice(12, 20)).buffer);
      const high = view.getUint32(0, false);
      const low = view.getUint32(4, false);
      nonce = (BigInt(high) << 32n) + BigInt(low);
    }
    
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
  } catch (e) {
    console.warn(`[BURN] WARNING: Failed to parse message bytes: ${e.message}`);
  }
  
  // Note: nonceBytes32 is already extracted above and used as messageHash
  // The uint64 nonce is only for logging/compatibility

  const sourceChain = CHAIN_ID_MAP[event.network] || `chain-${event.network}`;
  const destChain =
    DOMAIN_TO_CHAIN[Number(destinationDomain)] || `domain-${destinationDomain}`;

  // Log correlation key for verification
  // MessageReceived.nonce should be keccak256(message), but there may be encoding differences
  console.log(`[BURN] Computed keccak256(message): ${messageHash}`);
  console.log(`[BURN] Mint will look for: cctp:burn:${sourceChain}:${messageHash}`);
  console.log(`[BURN] Expected MessageReceived.nonce: keccak256(message) (may differ due to encoding)`);
  console.log(`[BURN] Expected MessageReceived on destination: domain ${destinationDomain} (${destChain})`);
  
  // NOTE: If matching still fails, MessageReceived.nonce might use different encoding
  // Possible causes: ABI encoding differences, messageBody format, or attestation-level computation

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
    messageBody: messageBodyFromSent || null, // Extracted from MessageSent.message (byte 148+)
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
      
      // Also store a fallback index by messageBody hash in case primary hash doesn't match
      // This allows matching even if keccak256(message) doesn't match MessageReceived.nonce
      if (messageBodyFromSent) {
        try {
          const messageBodyHash = ethers.keccak256(messageBodyFromSent).toLowerCase();
          const fallbackKey = `cctp:burn:${sourceChain}:body:${messageBodyHash}`;
          const fallbackData = { 
            ...burnData, 
            lookupKey: trackingKey,
            fallbackIndex: true,
            messageBodyHash: messageBodyHash
          };
          await storage.putJson(fallbackKey, fallbackData, { ttl: 604800 });
          console.log(`[BURN] Stored fallback index by messageBody hash: ${fallbackKey}`);
          console.log(`[BURN] Fallback hash: ${messageBodyHash}`);
          
          // Verify fallback write
          try {
            await new Promise(resolve => setTimeout(resolve, 100));
            const verify = await storage.getJson(fallbackKey);
            if (verify && Object.keys(verify).length > 0) {
              console.log(`[BURN] Fallback index verified: ${Object.keys(verify).length} fields stored`);
            } else {
              console.warn(`[BURN] WARNING: Fallback index write verification failed - empty object`);
            }
          } catch (verifyErr) {
            console.warn(`[BURN] Could not verify fallback index: ${verifyErr && verifyErr.message ? verifyErr.message : String(verifyErr)}`);
          }
        } catch (fallbackErr) {
          console.warn(`[BURN] Failed to store fallback index: ${fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr)}`);
          // Don't fail the entire operation if fallback fails
        }
      }
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

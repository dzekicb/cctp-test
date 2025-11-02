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
  const MESSAGE_TRANSMITTER_ADDRESS = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";

  const burnLog = event.logs.find(
    (log) => log.address?.toLowerCase() === TOKEN_MESSENGER_ADDRESS.toLowerCase(),
  );

  if (!burnLog) {
    console.error("[BURN] No DepositForBurn event found");
    return;
  }

  const burnLogIndex = event.logs.findIndex(log =>
    log.address?.toLowerCase() === TOKEN_MESSENGER_ADDRESS.toLowerCase()
  );

  let burnDecoded;
  try {
    const burnIface = new ethers.Interface(DEPOSIT_FOR_BURN_ABI);
    burnDecoded = burnIface.parseLog({
      topics: burnLog.topics,
      data: burnLog.data,
    });
  } catch (decodeError) {
    console.error(`[BURN] Decode failed: ${decodeError.message}`);
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
    (log) => log.address?.toLowerCase() === MESSAGE_TRANSMITTER_ADDRESS.toLowerCase(),
  );

  if (!candidateLogs || candidateLogs.length === 0) {
    console.error("[BURN] No MessageSent event found");
    return;
  }

  let messageBytes;
  let matchedHeader = null;

  const chainToDomain = {};
  Object.entries(DOMAIN_TO_CHAIN).forEach(([domain, chain]) => {
    chainToDomain[chain] = Number(domain);
  });
  const currentChainName = CHAIN_ID_MAP[event.network] || `chain-${event.network}`;
  const expectedSourceDomain = chainToDomain[currentChainName];

  const matchingCandidates = [];
  for (let i = 0; i < candidateLogs.length; i++) {
    const log = candidateLogs[i];
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

      let bytes;
      let msgHex;
      if (typeof msg === "string") {
        bytes = ethers.getBytes(msg);
        msgHex = msg.toLowerCase().startsWith("0x") ? msg : "0x" + msg;
      } else {
        bytes = msg;
        msgHex = ethers.hexlify(bytes);
      }

      if (bytes.length >= 12) {
        const view = new DataView(new Uint8Array(bytes.slice(0, 12)).buffer);
        const ver = view.getUint32(0, false);
        const srcDom = view.getUint32(4, false);
        const dstDom = view.getUint32(8, false);
        const logProximity = msgLogIndex !== -1 ? Math.abs(msgLogIndex - burnLogIndex) : "unknown";

        const destMatches = String(dstDom) === destinationDomain.toString();
        const srcMatches = expectedSourceDomain !== undefined ? srcDom === expectedSourceDomain : true;

        if (destMatches && srcMatches) {
          messageBytes = msg;
          matchedHeader = { ver, srcDom, dstDom };
          break;
        } else if (destMatches) {
          matchingCandidates.push({
            msg,
            header: { ver, srcDom, dstDom },
            logIndex: msgLogIndex,
            proximity: logProximity,
          });
        }
      }
    } catch (e) {
      console.warn(`[BURN] Failed to parse MessageSent candidate #${i}: ${e.message}`);
    }
  }

  if (!messageBytes && matchingCandidates.length > 0) {
    matchingCandidates.sort((a, b) => {
      if (typeof a.proximity === "number" && typeof b.proximity === "number") {
        return a.proximity - b.proximity;
      }
      return 0;
    });
    const selected = matchingCandidates[0];
    messageBytes = selected.msg;
    matchedHeader = selected.header;
  }

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
      console.error(`[BURN] Failed to decode any MessageSent: ${e.message}`);
    return;
  }
  }

  const msgBytes = ethers.getBytes(messageBytes);
  const messageBytesHex = ethers.hexlify(msgBytes);
  const messageHash = ethers.keccak256(messageBytesHex).toLowerCase();

  let messageBodyFromSent = null;
  if (msgBytes.length > 148) {
    const messageBodyBytes = msgBytes.slice(148);
    messageBodyFromSent = ethers.hexlify(messageBodyBytes).toLowerCase();
  }

  let nonce = BigInt(0);
  try {
    if (msgBytes.length >= 20) {
      const view = new DataView(new Uint8Array(msgBytes.slice(12, 20)).buffer);
      const high = view.getUint32(0, false);
      const low = view.getUint32(4, false);
      nonce = (BigInt(high) << 32n) + BigInt(low);
    }
  } catch (e) {
    console.warn(`[BURN] Failed to parse message bytes: ${e.message}`);
  }

  const sourceChain = CHAIN_ID_MAP[event.network] || `chain-${event.network}`;
  const destChain = DOMAIN_TO_CHAIN[Number(destinationDomain)] || `domain-${destinationDomain}`;

  const unsupportedDestChains = new Set([
    "solana",
    "hyperevm",
    "codex",
    "xdc",
    "arc-testnet",
  ]);
  if (unsupportedDestChains.has(destChain)) {
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
  const minFinality = Number(minFinalityThreshold);
  const transferType = minFinality <= 1000 ? "fast" : "standard";

  const burnData = {
    nonce: nonce.toString(),
    messageHash,
    messageBody: messageBodyFromSent || null,
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
    transferType,
    hookData: hookData,
    burnTimestamp: currentTimestamp,
    status: "pending",
  };

  const requiredFields = ["nonce", "messageHash", "sourceChain", "amount", "destinationDomain"];
  const missingFields = requiredFields.filter((f) => !burnData[f]);
  if (missingFields.length > 0) {
    console.error(`[BURN] Missing required fields: ${missingFields.join(", ")}`);
    return;
  }

  try {
    await storage.putJson(trackingKey, burnData, { ttl: 604800 });

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
      } catch (_) {}
    }
  } catch (writeErr) {
    console.error(`[BURN] Storage failed: ${writeErr.message}`);
    return;
  }

  try {
    const orphanedIndexKey = `cctp:orphanedIndex:${sourceChain}:${messageHash}`;
    const orphanedIndex = await storage.getJson(orphanedIndexKey).catch(() => null);
    if (orphanedIndex && orphanedIndex.pointer) {
      const completedKey = `cctp:completed:${sourceChain}:${messageHash}`;
      const completed = {
        nonce: burnData.nonce,
        messageHash: messageHash,
        messageBody: burnData.messageBody,
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
      await storage.delete(orphanedIndexKey).catch(() => {});
      await storage.delete(orphanedIndex.pointer).catch(() => {});
    }
  } catch (_) {}
};

module.exports = { storeBurnEvent };

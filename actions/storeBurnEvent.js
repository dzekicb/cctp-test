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

  const burnLog = event.logs.find(
    (log) =>
      log.address?.toLowerCase() === TOKEN_MESSENGER_ADDRESS.toLowerCase(),
  );

  if (!burnLog) {
    console.log("[BURN] ERROR: No DepositForBurn event found");
    return;
  }

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

  const messageSentLog = event.logs.find(
    (log) =>
      log.address?.toLowerCase() === MESSAGE_TRANSMITTER_ADDRESS.toLowerCase(),
  );

  if (!messageSentLog) {
    console.log("[BURN] ERROR: No MessageSent event found");
    return;
  }

  let messageSentDecoded;
  try {
    const messageIface = new ethers.Interface(MESSAGE_SENT_ABI);
    messageSentDecoded = messageIface.parseLog({
      topics: messageSentLog.topics,
      data: messageSentLog.data,
    });
  } catch (decodeError) {
    console.error(
      `[BURN] ERROR: MessageSent decode failed: ${decodeError.message}`,
    );
    return;
  }

  const messageBytes = messageSentDecoded.args.message;

  // Parse message structure to extract nonce safely from bytes
  // Format: version(4) + sourceDomain(4) + destDomain(4) + nonce(8) + ...
  let nonce = BigInt(0);
  try {
    const msgBytes = ethers.getBytes(messageBytes);
    // Ensure the message contains at least the first 20 bytes (4 + 4 + 4 + 8)
    if (msgBytes.length >= 20) {
      // Nonce occupies bytes [12, 20)
      const view = new DataView(new Uint8Array(msgBytes.slice(12, 20)).buffer);
      // Read as big-endian uint64
      const high = view.getUint32(0, false);
      const low = view.getUint32(4, false);
      nonce = (BigInt(high) << 32n) + BigInt(low);
    } else {
      console.warn(
        `[BURN] WARNING: Message too short to contain nonce. Length: ${msgBytes.length} bytes`,
      );
    }
  } catch (e) {
    console.warn(`[BURN] WARNING: Failed to parse message bytes for nonce: ${e.message}`);
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

  const trackingKey = `cctp:burn:${sourceChain}:${nonce}`;
  const currentTimestamp = Math.floor(Date.now() / 1000);

  const burnData = {
    nonce: nonce.toString(),
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
    hookData: hookData,
    burnTimestamp: currentTimestamp,
    status: "pending",
  };

  console.log(
    `[BURN] Storing | Nonce: ${nonce} | ${sourceChain} -> ${destChain} | Amount: ${amount.toString()}`,
  );

  try {
    await storage.putJson(trackingKey, burnData, { ttl: 604800 });
    console.log(`[BURN] Success`);
  } catch (storageError) {
    console.error(`[BURN] ERROR: Storage failed: ${storageError.message}`);
  }
};

module.exports = { storeBurnEvent };

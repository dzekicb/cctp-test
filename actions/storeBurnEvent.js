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

  // Parse message structure to extract nonce
  // Format: version(4) + sourceDomain(4) + destDomain(4) + nonce(8) + sender(32) + recipient(32) + ...
  const nonceHex = messageBytes.slice(26, 42); // Extract 8 bytes (16 hex chars) starting at position 12 bytes
  const nonce = BigInt("0x" + nonceHex);

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

  // Skip if destination is Solana (non-EVM, can't be matched)
  if (destChain === "solana") {
    console.log(
      `[BURN] Skipping | Destination is Solana (non-EVM) | Nonce: ${nonce}`,
    );
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

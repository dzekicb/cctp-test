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

  const targetLog = event.logs.find(
    (log) => log.address?.toLowerCase() === TARGET_ADDRESS.toLowerCase(),
  );

  if (!targetLog) {
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
    console.error(`[MINT] Decode failed: ${decodeError.message}`);
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

  const nonceHex = (typeof nonce === "string" ? nonce : ethers.hexlify(nonce)).toLowerCase();

  const msgBodyBytes = ethers.getBytes(messageBody || "0x");
  const messageBodyHex = ethers.hexlify(msgBodyBytes).toLowerCase();

  const sourceChain = DOMAIN_TO_CHAIN[Number(sourceDomain)];
  const destChain = CHAIN_ID_MAP[event.network] || `chain-${event.network}`;

  if (!sourceChain) {
    return;
  }

  const unsupportedSourceChains = new Set([
    "solana",
    "hyperevm",
    "codex",
    "xdc",
    "arc-testnet",
  ]);
  if (unsupportedSourceChains.has(sourceChain)) {
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

  let burnData;
  let burnFound = false;
  try {
    const retrieved = await storage.getJson(trackingKey);
    if (retrieved && typeof retrieved === "object") {
      const keys = Object.keys(retrieved);
      if (keys.length > 0) {
        burnData = retrieved;
        burnFound = true;
      }
    }
  } catch (_) {}

  if (!burnFound && messageBodyHex && messageBodyHex.length > 2) {
    const messageBodyHash = ethers.keccak256(messageBodyHex).toLowerCase();
    const fallbackKey = `cctp:burn:${sourceChain}:body:${messageBodyHash}`;
    try {
      const fallbackIndex = await storage.getJson(fallbackKey);
      if (fallbackIndex && typeof fallbackIndex === "object" && fallbackIndex.k) {
        try {
          const primaryRecord = await storage.getJson(fallbackIndex.k);
          if (primaryRecord && Object.keys(primaryRecord).length > 0) {
            burnData = primaryRecord;
            burnFound = true;
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  const currentTimestamp = Math.floor(Date.now() / 1000);

  const requiredFields = {
    n: burnData?.n,
    sc: burnData?.sc,
    amt: burnData?.amt,
  };
  const missingFields = Object.entries(requiredFields)
    .filter(([key, value]) => !value)
    .map(([key]) => key);
  const hasBurnData = burnFound && missingFields.length === 0;

  if (hasBurnData) {
    let duration = null;
    if (burnData.bt) {
      duration = currentTimestamp - burnData.bt;
    }

    const completeTransfer = {
      n: burnData.n,
      h: burnData.h || nonceHex,
      sc: burnData.sc,
      sci: burnData.sci,
      stx: burnData.stx,
      sblk: burnData.sblk,
      tk: burnData.tk,
      amt: burnData.amt,
      dep: burnData.dep,
      dd: burnData.dd,
      dc: destChain,
      dci: event.network,
      dtx: event.hash,
      dblk: event.blockNumber,
      mf: burnData.mf,
      fth: burnData.fth,
      tt: burnData.tt || "unknown",
      bt: burnData.bt,
      mt: currentTimestamp,
      mr: {
        c: caller,
        s: sender,
        ft: Number(finalityThresholdExecuted),
      },
      dur: duration,
    };

    const completedKey = `cctp:completed:${sourceChain}:${nonceHex}`;

    try {
      await storage.putJson(completedKey, completeTransfer, { ttl: 2592000 });
      await storage.delete(trackingKey);

      const slackWebhook = await context.secrets.get("SLACK_WEBHOOK_URL");
      if (slackWebhook) {
        const formatUSDC = (amountStr) => {
          try {
            const amountBigInt = BigInt(amountStr);
            const decimals = 6;
            const divisor = BigInt(10 ** decimals);
            const whole = amountBigInt / divisor;
            const fractional = amountBigInt % divisor;

            if (fractional === 0n) {
              return `${whole.toLocaleString()} USDC`;
            }

            const fractionalStr = fractional.toString().padStart(decimals, "0");
            const trimmed = fractionalStr.replace(/0+$/, "");
            return `${whole.toLocaleString()}.${trimmed} USDC`;
          } catch (e) {
            return `${amountStr} (raw)`;
          }
        };

        const formatDuration = (seconds) => {
          if (!seconds) return "N/A";
          if (seconds < 60) return `${seconds}s`;
          if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
          const hours = Math.floor(seconds / 3600);
          const mins = Math.floor((seconds % 3600) / 60);
          return `${hours}h ${mins}m`;
        };

        const capitalizeChain = (chainName) => {
          if (!chainName) return chainName;
          return chainName.charAt(0).toUpperCase() + chainName.slice(1);
        };

        const formattedAmount = formatUSDC(completeTransfer.amt);
        const duration = formatDuration(completeTransfer.dur);
        const transferType = completeTransfer.tt || "unknown";
        const typeEmoji = transferType === "fast" ? "⚡" : "📋";
        const sourceChainName = capitalizeChain(completeTransfer.sc);
        const destChainName = capitalizeChain(completeTransfer.dc || destChain);

        const blocks = [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `${typeEmoji} CCTP Transfer Completed`,
              emoji: true,
            },
          },
          {
            type: "divider",
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `*🔄 Route*\n*${sourceChainName}* → *${destChainName}*`,
              },
              {
                type: "mrkdwn",
                text: `*${typeEmoji} Type*\n${transferType.toUpperCase()}`,
              },
              {
                type: "mrkdwn",
                text: `*💰 Amount*\n*${formattedAmount}*`,
              },
              {
                type: "mrkdwn",
                text: `*⏱️ Duration*\n${duration}`,
              },
            ],
          },
          {
            type: "divider",
          },
          {
            type: "section",
            fields: [
                {
                  type: "mrkdwn",
                  text: `*📤 Source Chain*\n<https://tdly.co/tx/${completeTransfer.stx}|${sourceChainName}>\nBlock: ${completeTransfer.sblk || "N/A"}`,
                },
                {
                  type: "mrkdwn",
                  text: `*📥 Destination Chain*\n<https://tdly.co/tx/${completeTransfer.dtx || event.hash}|${destChainName}>\nBlock: ${completeTransfer.dblk || event.blockNumber || "N/A"}`,
                },
            ],
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*🔑 Message Hash*\n\`${nonceHex}\``,
            },
          },
        ];

          const contextElements = [];
          if (completeTransfer.fth) {
            contextElements.push({
              type: "mrkdwn",
              text: `Finality: ${completeTransfer.fth}`,
            });
          }
          if (completeTransfer.dep) {
            contextElements.push({
              type: "mrkdwn",
              text: `Depositor: \`${completeTransfer.dep}\``,
            });
          }
          if (completeTransfer.mf && completeTransfer.mf !== "0") {
            const feeFormatted = formatUSDC(completeTransfer.mf);
            contextElements.push({
              type: "mrkdwn",
              text: `Max Fee: ${feeFormatted}`,
            });
          }

        if (contextElements.length > 0) {
          blocks.push({
            type: "context",
            elements: contextElements,
          });
        }

        const msg = {
          blocks: blocks,
          text: `CCTP ${transferType} transfer: ${formattedAmount} from ${sourceChainName} to ${destChainName}`,
        };

        try {
          await fetch(slackWebhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg),
          });
          await storage.delete(completedKey);
        } catch (notifyError) {
          console.error(`[MINT] Error sending Slack notification: ${notifyError.message}`);
        }
      }
    } catch (storageError) {
      console.error(`[MINT] Storage failed: ${storageError.message}`);
    }
  } else {
    if (burnFound && burnData) {
      try {
        await storage.delete(trackingKey);
      } catch (_) {}
    }

    const orphanedKey = `cctp:orphaned:${destChain}:${nonceHex}:${currentTimestamp}`;
    const orphanedIndexKey = `cctp:orphanedIndex:${sourceChain}:${nonceHex}`;

    const orphanedData = {
      dc: destChain,
      dci: event.network,
      dtx: event.hash,
      dblk: event.blockNumber,
      n: burnData && burnData.n ? burnData.n : undefined,
      h: nonceHex,
      sd: Number(sourceDomain),
      sc: sourceChain,
      mt: currentTimestamp,
      c: caller,
      s: sender,
      ft: Number(finalityThresholdExecuted),
    };

    try {
      await storage.putJson(orphanedKey, orphanedData, { ttl: 604800 });
      await storage.putJson(
        orphanedIndexKey,
        { pointer: orphanedKey, createdAt: currentTimestamp, src: sourceChain, dst: destChain },
        { ttl: 604800 },
      );

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
      }
    } catch (error) {
      console.error(`[MINT] Failed to store orphaned mint: ${error.message}`);
    }
  }
};

module.exports = { matchMintEvent };

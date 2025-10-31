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

const notifyOnSuccess = async (context, event) => {
	const storage = context.storage;
	const TARGET_ADDRESS = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";

	console.log(`[SUCCESS] Processing transaction: ${event.hash}`);
	console.log(
		`[SUCCESS] Network: ${CHAIN_ID_MAP[event.network] || event.network} (${event.network}), Block: ${event.blockNumber}`,
	);

	const targetLog = event.logs.find(
		(log) => log.address?.toLowerCase() === TARGET_ADDRESS.toLowerCase(),
	);
	if (!targetLog) {
		console.log("[SUCCESS] No MessageReceived log in tx; skipping.");
		return;
	}

	let decoded;
	try {
		const iface = new ethers.Interface(MESSAGE_RECEIVED_ABI);
		decoded = iface.parseLog({ topics: targetLog.topics, data: targetLog.data });
	} catch (e) {
		return;
	}

	const { sourceDomain, nonce } = decoded.args;
	const sourceChain = DOMAIN_TO_CHAIN[Number(sourceDomain)];
	const destChain = CHAIN_ID_MAP[event.network] || `chain-${event.network}`;

	// Unsupported chains are ignored
	const unsupported = new Set(["solana", "hyperevm", "codex", "xdc", "arc-testnet"]);
	if (!sourceChain || unsupported.has(sourceChain)) {
		console.log(`[SUCCESS] Unsupported or unknown source: ${sourceDomain}`);
		return;
	}

	const nonceHex = (typeof nonce === "string" ? nonce : ethers.hexlify(nonce)).toLowerCase();
	const completedKey = `cctp:completed:${sourceChain}:${nonceHex}`;
	const notifiedKey = `cctp:notified:${sourceChain}:${nonceHex}`;

	console.log(`[SUCCESS] Checking for completed record: ${completedKey}`);

	let alreadyNotified;
	try {
		alreadyNotified = await storage.getJson(notifiedKey);
		if (alreadyNotified && Object.keys(alreadyNotified).length > 0 && alreadyNotified.notified) {
			console.log(`[SUCCESS] Already notified for ${nonceHex}; skipping.`);
			return;
		}
	} catch (_) {}

	let completed;
	try {
		completed = await storage.getJson(completedKey);
		if (completed && Object.keys(completed).length === 0) {
			// Empty object means doesn't exist
			completed = null;
		}
	} catch (_) {}

	// Only notify if transfer is completed
	if (!completed || !completed.amount) {
		console.log(`[SUCCESS] No completed record yet for ${completedKey} (record may not exist or incomplete)`);
		return;
	}

	console.log(`[SUCCESS] Found completed record | Type: ${completed.transferType || "unknown"} | Duration: ${completed.durationSeconds || "?"}s`);

	const amount = completed.amount;
	const slackWebhook = await context.secrets.get("SLACK_WEBHOOK_URL");
	if (!slackWebhook) {
		console.log(`[SUCCESS] No SLACK_WEBHOOK_URL configured; skipping notify.`);
		return;
	}

	// Format amount for display (USDC has 6 decimals)
	const formatUSDC = (amountStr) => {
		try {
			const amountBigInt = BigInt(amountStr);
			const decimals = 6; // USDC has 6 decimals
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

	// Format duration
	const formatDuration = (seconds) => {
		if (!seconds) return "N/A";
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		const hours = Math.floor(seconds / 3600);
		const mins = Math.floor((seconds % 3600) / 60);
		return `${hours}h ${mins}m`;
	};

	// Get explorer URLs (Tenderly format)
	const getExplorerUrl = (txHash) => {
		return `https://tdly.co/tx/${txHash}`;
	};

	// Capitalize first letter of chain name
	const capitalizeChain = (chainName) => {
		if (!chainName) return chainName;
		return chainName.charAt(0).toUpperCase() + chainName.slice(1);
	};

	const now = Math.floor(Date.now() / 1000);
	const formattedAmount = formatUSDC(completed.amount);
	const duration = formatDuration(completed.durationSeconds);
	const transferType = completed.transferType || "unknown";
	const typeEmoji = transferType === "fast" ? "⚡" : "📋";
	const typeColor = transferType === "fast" ? "#FF6B6B" : "#4ECDC4";
	
	const sourceChainName = capitalizeChain(completed.sourceChain);
	const destChainName = capitalizeChain(completed.destinationChain || destChain);
	
	const sourceExplorer = getExplorerUrl(completed.sourceTxHash);
	const destExplorer = getExplorerUrl(completed.destinationTxHash || event.hash);

	// Create rich Slack Block Kit message
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
					text: `*📤 Source Chain*\n<${sourceExplorer}|${sourceChainName}>\nBlock: ${completed.sourceBlockNumber || "N/A"}`,
				},
				{
					type: "mrkdwn",
					text: `*📥 Destination Chain*\n<${destExplorer}|${destChainName}>\nBlock: ${completed.destinationBlockNumber || event.blockNumber || "N/A"}`,
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

	// Add additional context information
	const contextElements = [];
	
	if (completed.minFinalityThreshold) {
		contextElements.push({
			type: "mrkdwn",
			text: `Finality: ${completed.minFinalityThreshold}`,
		});
	}
	
	if (completed.depositor) {
		contextElements.push({
			type: "mrkdwn",
			text: `Depositor: \`${completed.depositor}\``,
		});
	}
	
	if (completed.maxFee && completed.maxFee !== "0") {
		const feeFormatted = formatUSDC(completed.maxFee);
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
		text: `CCTP ${transferType} transfer: ${formattedAmount} from ${sourceChainName} to ${destChainName}`, // Fallback text
	};

	try {
		await fetch(slackWebhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(msg),
		});
		await storage.putJson(notifiedKey, { notified: true, at: now }, { ttl: 2592000 });
		console.log(`[SUCCESS] Slack notification sent with rich formatting.`);
	} catch (e) {
		console.error(`[SUCCESS] ERROR sending Slack notification: ${e && e.message ? e.message : String(e)}`);
	}
};

module.exports = { notifyOnSuccess };



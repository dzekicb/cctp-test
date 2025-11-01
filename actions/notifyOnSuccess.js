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

	const targetLog = event.logs.find(
		(log) => log.address?.toLowerCase() === TARGET_ADDRESS.toLowerCase(),
	);
	if (!targetLog) {
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

	const unsupported = new Set(["solana", "hyperevm", "codex", "xdc", "arc-testnet"]);
	if (!sourceChain || unsupported.has(sourceChain)) {
		return;
	}

	const nonceHex = (typeof nonce === "string" ? nonce : ethers.hexlify(nonce)).toLowerCase();
	const completedKey = `cctp:completed:${sourceChain}:${nonceHex}`;

	let completed;
	try {
		completed = await storage.getJson(completedKey);
		if (completed && Object.keys(completed).length === 0) {
			completed = null;
		}
	} catch (_) {}

	if (!completed || !completed.amount) {
		return;
	}

	const slackWebhook = await context.secrets.get("SLACK_WEBHOOK_URL");
	if (!slackWebhook) {
		return;
	}

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

	const formattedAmount = formatUSDC(completed.amount);
	const duration = formatDuration(completed.durationSeconds);
	const transferType = completed.transferType || "unknown";
	const typeEmoji = transferType === "fast" ? "⚡" : "📋";
	const sourceChainName = capitalizeChain(completed.sourceChain);
	const destChainName = capitalizeChain(completed.destinationChain || destChain);

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
					text: `*📤 Source Chain*\n<https://tdly.co/tx/${completed.sourceTxHash}|${sourceChainName}>\nBlock: ${completed.sourceBlockNumber || "N/A"}`,
				},
				{
					type: "mrkdwn",
					text: `*📥 Destination Chain*\n<https://tdly.co/tx/${completed.destinationTxHash || event.hash}|${destChainName}>\nBlock: ${completed.destinationBlockNumber || event.blockNumber || "N/A"}`,
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
		text: `CCTP ${transferType} transfer: ${formattedAmount} from ${sourceChainName} to ${destChainName}`,
	};

	try {
		await fetch(slackWebhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(msg),
		});
		await storage.delete(completedKey);
	} catch (e) {
		console.error(`[SUCCESS] Error sending Slack notification: ${e.message}`);
	}
};

module.exports = { notifyOnSuccess };

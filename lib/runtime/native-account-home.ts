import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { autoSyncActiveAccountToCodex } from "../codex-manager.js";
import { loadAccounts, type AccountMetadataV3 } from "../storage.js";

const RUNTIME_ROTATION_PROXY_PROVIDER_ID = "codex-multi-auth-runtime-proxy";

export interface NativeCodexHomeBaseContext {
	args: string[];
	env: NodeJS.ProcessEnv;
	cleanup?: () => void;
	originalCodexHome?: string;
}

export interface NativeCodexHomeContext extends NativeCodexHomeBaseContext {
	nativeCodexHome?: string;
}

function readTrimmed(value: string | undefined): string | undefined {
	const trimmed = (value ?? "").trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveOriginalCodexHome(context: NativeCodexHomeBaseContext): string | null {
	const homeDir = readTrimmed(process.env.HOME);
	return (
		readTrimmed(context.originalCodexHome) ??
		readTrimmed(context.env.CODEX_HOME) ??
		(homeDir ? join(homeDir, ".codex") : null)
	);
}

function resolveOriginalMultiAuthDir(
	context: NativeCodexHomeBaseContext,
	originalCodexHome: string,
): string {
	return (
		readTrimmed(context.env.CODEX_MULTI_AUTH_DIR) ??
		readTrimmed(process.env.CODEX_MULTI_AUTH_DIR) ??
		join(originalCodexHome, "multi-auth")
	);
}

function resolveActiveAccount(
	storage: Awaited<ReturnType<typeof loadAccounts>>,
): AccountMetadataV3 | null {
	if (!storage || storage.accounts.length === 0) {
		return null;
	}

	const rawIndex = storage.activeIndexByFamily?.codex ?? storage.activeIndex;
	const index =
		typeof rawIndex === "number" && Number.isFinite(rawIndex)
			? Math.max(0, Math.min(Math.trunc(rawIndex), storage.accounts.length - 1))
			: 0;
	const account = storage.accounts[index];
	if (!account || account.enabled === false) {
		return null;
	}
	return account;
}

function createNativeHomeKey(account: AccountMetadataV3): string {
	const identity = JSON.stringify({
		accountId: account.accountId ?? "",
		email: account.email ?? "",
		refreshToken: account.refreshToken,
	});
	const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
	return `account-${digest}`;
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

function stripRuntimeRotationProxyConfig(rawConfig: string): string {
	const lines = rawConfig.split(/\r?\n/);
	const nextLines: string[] = [];
	let skippingProxyProvider = false;

	for (const line of lines) {
		const trimmed = line.trim();
		const isSection = /^\[/.test(trimmed);
		if (isSection) {
			skippingProxyProvider =
				/^\[\s*model_providers\s*\.\s*(?:"codex-multi-auth-runtime-proxy"|codex-multi-auth-runtime-proxy)\s*\]\s*$/.test(
					trimmed,
				);
			if (skippingProxyProvider) {
				continue;
			}
		}
		if (skippingProxyProvider) {
			continue;
		}
		if (
			new RegExp(
				`^\\s*model_provider\\s*=\\s*["']${RUNTIME_ROTATION_PROXY_PROVIDER_ID}["']\\s*(?:#.*)?$`,
			).test(line)
		) {
			continue;
		}
		nextLines.push(line);
	}

	return ensureTrailingNewline(nextLines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

async function copyNativeConfig(sourceHome: string, nativeHome: string): Promise<void> {
	const sourceConfigPath = join(sourceHome, "config.toml");
	const nativeConfigPath = join(nativeHome, "config.toml");
	let rawConfig = "";
	if (existsSync(sourceConfigPath)) {
		rawConfig = await fs.readFile(sourceConfigPath, "utf-8");
	}
	const nextConfig = stripRuntimeRotationProxyConfig(rawConfig);
	await fs.mkdir(nativeHome, { recursive: true, mode: 0o700 });
	await fs.writeFile(nativeConfigPath, nextConfig, {
		encoding: "utf-8",
		mode: 0o600,
	});
}

function buildNativeAccountsPayload(account: AccountMetadataV3): Record<string, unknown> {
	const tokens: Record<string, unknown> = {
		refresh_token: account.refreshToken,
		refreshToken: account.refreshToken,
	};
	if (account.accessToken) {
		tokens.access_token = account.accessToken;
		tokens.accessToken = account.accessToken;
	}
	if (account.accountId) {
		tokens.account_id = account.accountId;
		tokens.accountId = account.accountId;
	}

	const accountRecord: Record<string, unknown> = {
		active: true,
		isActive: true,
		is_active: true,
		refreshToken: account.refreshToken,
		refresh_token: account.refreshToken,
		auth: { tokens },
	};
	if (account.accessToken) {
		accountRecord.accessToken = account.accessToken;
		accountRecord.access_token = account.accessToken;
	}
	if (account.accountId) {
		accountRecord.accountId = account.accountId;
		accountRecord.account_id = account.accountId;
	}
	if (account.email) {
		accountRecord.email = account.email;
	}

	const payload: Record<string, unknown> = {
		accounts: [accountRecord],
		codexMultiAuthNativeHomeVersion: 1,
		codexMultiAuthSyncVersion: Date.now(),
	};
	if (account.accountId) {
		payload.activeAccountId = account.accountId;
		payload.active_account_id = account.accountId;
	}
	if (account.email) {
		payload.activeEmail = account.email;
		payload.active_email = account.email;
	}
	return payload;
}

async function seedNativeAccountsFile(
	nativeHome: string,
	account: AccountMetadataV3,
): Promise<void> {
	const accountsPath = join(nativeHome, "accounts.json");
	await fs.writeFile(accountsPath, JSON.stringify(buildNativeAccountsPayload(account), null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
}

async function withTemporaryEnv<T>(
	overrides: Record<string, string | undefined>,
	task: () => Promise<T>,
): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return await task();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

async function loadActiveAccountForContext(
	context: NativeCodexHomeBaseContext,
	multiAuthDir: string,
): Promise<AccountMetadataV3 | null> {
	return withTemporaryEnv(
		{
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
		},
		async () => resolveActiveAccount(await loadAccounts()),
	);
}

async function syncActiveAccountToNativeHome(
	nativeHome: string,
	multiAuthDir: string,
): Promise<boolean> {
	return withTemporaryEnv(
		{
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_CLI_ACCOUNTS_PATH: join(nativeHome, "accounts.json"),
			CODEX_CLI_AUTH_PATH: join(nativeHome, "auth.json"),
			CODEX_CLI_CONFIG_PATH: join(nativeHome, "config.toml"),
			CODEX_MULTI_AUTH_SYNC_CODEX_CLI: "1",
		},
		async () => autoSyncActiveAccountToCodex(),
	);
}

export async function prepareNativeCodexHomeContext(
	context: NativeCodexHomeBaseContext,
): Promise<NativeCodexHomeContext> {
	const originalCodexHome = resolveOriginalCodexHome(context);
	if (!originalCodexHome) {
		return context;
	}

	const sourceCodexHome = readTrimmed(context.env.CODEX_HOME) ?? originalCodexHome;
	const multiAuthDir = resolveOriginalMultiAuthDir(context, originalCodexHome);
	const account = await loadActiveAccountForContext(context, multiAuthDir);
	if (!account) {
		return context;
	}

	const nativeHome = join(multiAuthDir, "native-homes", createNativeHomeKey(account));
	await copyNativeConfig(sourceCodexHome, nativeHome);
	await seedNativeAccountsFile(nativeHome, account);

	const synced = await syncActiveAccountToNativeHome(nativeHome, multiAuthDir);
	if (!synced) {
		return context;
	}

	const refreshedAccount = await loadActiveAccountForContext(context, multiAuthDir);
	if (refreshedAccount) {
		await seedNativeAccountsFile(nativeHome, refreshedAccount);
		await syncActiveAccountToNativeHome(nativeHome, multiAuthDir);
	}

	return {
		...context,
		env: {
			...context.env,
			CODEX_HOME: nativeHome,
			CODEX_CLI_ACCOUNTS_PATH: join(nativeHome, "accounts.json"),
			CODEX_CLI_AUTH_PATH: join(nativeHome, "auth.json"),
			CODEX_CLI_CONFIG_PATH: join(nativeHome, "config.toml"),
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
		},
		cleanup: context.cleanup,
		originalCodexHome,
		nativeCodexHome: nativeHome,
	};
}

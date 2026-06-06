import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareNativeCodexHomeContext } from "../lib/runtime/native-account-home.js";

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createFixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "native-account-home-"));
	createdDirs.push(root);
	return root;
}

describe("native Codex account homes", () => {
	it("writes a selected-account native Codex home without stale runtime proxy config", async () => {
		const root = createFixtureRoot();
		const originalHome = join(root, "codex-home");
		const multiAuthDir = join(root, "multi-auth");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(multiAuthDir, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			[
				'model = "gpt-5-codex"',
				'model_provider = "codex-multi-auth-runtime-proxy"',
				"",
				"[model_providers.openai]",
				'name = "OpenAI"',
				'base_url = "https://api.openai.com/v1"',
				"",
				"[model_providers.codex-multi-auth-runtime-proxy]",
				'name = "stale"',
				'base_url = "http://127.0.0.1:1"',
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(multiAuthDir, "openai-codex-accounts.json"),
			`${JSON.stringify(
				{
					version: 3,
					activeIndex: 0,
					activeIndexByFamily: { codex: 0 },
					accounts: [
						{
							accountId: "acct_one",
							email: "one@example.com",
							refreshToken: "refresh-token-with-enough-length",
							accessToken: "access-token",
							expiresAt: Date.now() + 60 * 60_000,
							addedAt: Date.now(),
							lastUsed: Date.now(),
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const context = await prepareNativeCodexHomeContext({
			args: ["exec", "status"],
			env: {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
			},
			originalCodexHome: originalHome,
		});

		expect(context.env.CODEX_HOME).toContain(join(multiAuthDir, "native-homes"));
		expect(context.env.CODEX_CLI_AUTH_PATH).toBe(
			join(context.env.CODEX_HOME ?? "", "auth.json"),
		);
		expect(existsSync(join(context.env.CODEX_HOME ?? "", "auth.json"))).toBe(true);
		expect(existsSync(join(context.env.CODEX_HOME ?? "", "accounts.json"))).toBe(true);

		const config = readFileSync(
			join(context.env.CODEX_HOME ?? "", "config.toml"),
			"utf8",
		);
		expect(config).toContain("[model_providers.openai]");
		expect(config).not.toContain("codex-multi-auth-runtime-proxy");

		const auth = JSON.parse(
			readFileSync(join(context.env.CODEX_HOME ?? "", "auth.json"), "utf8"),
		);
		expect(auth.auth_mode).toBe("chatgpt");
		expect(auth.OPENAI_API_KEY).toBeNull();
		expect(auth.email).toBe("one@example.com");
		expect(auth.tokens.refresh_token).toBe("refresh-token-with-enough-length");
		expect(auth.tokens.access_token).toBe("access-token");
	});
});

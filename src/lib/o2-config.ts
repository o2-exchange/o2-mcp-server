import path from "node:path";
import os from "node:os";

const DEVNET_BASE_URL = "https://api.devnet.o2.app";
const TESTNET_BASE_URL = "https://api.testnet.o2.app";
const MAINNET_BASE_URL = "https://api.o2.app";

const DEVNET_PROVIDER_URL = "https://devnet.fuel.network/v1/graphql";
const TESTNET_PROVIDER_URL = "https://testnet.fuel.network/v1/graphql";
const MAINNET_PROVIDER_URL = "https://mainnet.fuel.network/v1/graphql";

function getEnvValue(key: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string> } })
    .process?.env;
  return env?.[key];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function resolveApiBaseUrl(override?: string): string {
  const directOverride = override?.trim();
  if (directOverride) {
    return normalizeBaseUrl(directOverride);
  }

  const envBaseUrl = getEnvValue("O2_API_BASE_URL")?.trim();
  if (envBaseUrl) {
    return normalizeBaseUrl(envBaseUrl);
  }

  const envNetwork = getEnvValue("O2_NETWORK")?.trim().toLowerCase();
  if (envNetwork === "mainnet") {
    return MAINNET_BASE_URL;
  }
  if (envNetwork === "testnet") {
    return TESTNET_BASE_URL;
  }

  return DEVNET_BASE_URL;
}

export function resolveOwnerId(override?: string): string | undefined {
  const directOverride = override?.trim();
  if (directOverride) {
    return directOverride;
  }
  const envOwner = getEnvValue("O2_OWNER_ID")?.trim();
  return envOwner || undefined;
}

export function resolveOwnerPrivateKey(override?: string): string | undefined {
  const directOverride = override?.trim();
  if (directOverride) {
    return directOverride;
  }
  const envKey = getEnvValue("O2_PRIVATE_KEY")?.trim();
  return envKey || undefined;
}

export function resolveSessionPrivateKey(override?: string): string | undefined {
  const directOverride = override?.trim();
  if (directOverride) {
    return directOverride;
  }
  const envKey = getEnvValue("O2_SESSION_PRIVATE_KEY")?.trim();
  return envKey || undefined;
}

export function resolveProviderUrl(override?: string): string {
  const directOverride = override?.trim();
  if (directOverride) {
    return directOverride;
  }

  const envProvider = getEnvValue("O2_PROVIDER_URL")?.trim();
  if (envProvider) {
    return envProvider;
  }

  const envNetwork = getEnvValue("O2_NETWORK")?.trim().toLowerCase();
  if (envNetwork === "mainnet") {
    return MAINNET_PROVIDER_URL;
  }
  if (envNetwork === "testnet") {
    return TESTNET_PROVIDER_URL;
  }

  return DEVNET_PROVIDER_URL;
}

export function resolveSessionStorePath(override?: string): string {
  const directOverride = override?.trim();
  if (directOverride) {
    return directOverride;
  }

  const envPath = getEnvValue("O2_SESSION_STORE_PATH")?.trim();
  if (envPath) {
    return envPath;
  }

  return path.join(os.homedir(), ".o2-mcp", "sessions.json");
}

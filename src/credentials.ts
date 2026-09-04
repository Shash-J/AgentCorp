import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { AgentCorpError } from "./errors.js";
import type { OrgConfig } from "./types.js";

export interface CredentialsFile {
  adminToken: string;
  roleTokens: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export function generateToken(prefix = "ac"): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export function loadCredentials(filePath = ".agentcorp/credentials.json"): CredentialsFile | null {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return null;
  }
  try {
    const raw = readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as CredentialsFile;
    if (!parsed.adminToken || typeof parsed.roleTokens !== "object") {
      throw new Error("Invalid credentials file format");
    }
    return parsed;
  } catch (error) {
    throw new AgentCorpError(
      "INVALID_CREDENTIALS",
      `Could not read credentials at ${absolutePath}: ${String(error)}`,
    );
  }
}

export function ensureCredentials(
  config: OrgConfig,
  filePath = ".agentcorp/credentials.json",
): CredentialsFile {
  const absolutePath = resolve(filePath);
  const now = new Date().toISOString();
  let existing: CredentialsFile | null = null;

  if (existsSync(absolutePath)) {
    existing = loadCredentials(absolutePath);
  }

  const roleTokens: Record<string, string> = { ...(existing?.roleTokens ?? {}) };
  let modified = false;

  for (const role of config.roles) {
    if (!roleTokens[role.id]) {
      roleTokens[role.id] = generateToken(`role_${role.id}`);
      modified = true;
    }
  }

  const adminToken = existing?.adminToken ?? generateToken("admin");
  if (!existing || existing.adminToken !== adminToken) {
    modified = true;
  }

  const credentials: CredentialsFile = {
    adminToken,
    roleTokens,
    createdAt: existing?.createdAt ?? now,
    updatedAt: modified ? now : (existing?.updatedAt ?? now),
  };

  if (!existing || modified) {
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, JSON.stringify(credentials, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return credentials;
}

export function resolveCallerFromToken(
  token: string,
  credentials: CredentialsFile,
): { type: "admin" } | { type: "role"; roleId: string } | null {
  if (!token) return null;
  if (token === credentials.adminToken) {
    return { type: "admin" };
  }
  for (const [roleId, roleToken] of Object.entries(credentials.roleTokens)) {
    if (token === roleToken) {
      return { type: "role", roleId };
    }
  }
  return null;
}

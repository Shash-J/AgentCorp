import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureCredentials,
  loadCredentials,
  resolveCallerFromToken,
} from "../src/credentials.js";
import { OrgConfigSchema } from "../src/types.js";

describe("credentials", () => {
  let tempDir: string;
  let credPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentcorp-cred-test-"));
    credPath = join(tempDir, "credentials.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const testConfig = OrgConfigSchema.parse({
    company: { name: "Test Corp" },
    roles: [
      { id: "architect", artifact_visibility: "all" },
      { id: "developer", artifact_visibility: "all" },
    ],
    policies: [],
  });

  it("generates credentials for all configured roles and admin", () => {
    const creds = ensureCredentials(testConfig, credPath);
    expect(creds.adminToken).toMatch(/^admin_/);
    expect(creds.roleTokens.architect).toMatch(/^role_architect_/);
    expect(creds.roleTokens.developer).toMatch(/^role_developer_/);

    const loaded = loadCredentials(credPath);
    expect(loaded).toEqual(creds);
  });

  it("preserves existing tokens when adding a new role", () => {
    const initial = ensureCredentials(testConfig, credPath);
    const updatedConfig = OrgConfigSchema.parse({
      company: { name: "Test Corp" },
      roles: [
        { id: "architect", artifact_visibility: "all" },
        { id: "developer", artifact_visibility: "all" },
        { id: "reviewer", artifact_visibility: "all" },
      ],
      policies: [],
    });

    const second = ensureCredentials(updatedConfig, credPath);
    expect(second.adminToken).toBe(initial.adminToken);
    expect(second.roleTokens.architect).toBe(initial.roleTokens.architect);
    expect(second.roleTokens.developer).toBe(initial.roleTokens.developer);
    expect(second.roleTokens.reviewer).toMatch(/^role_reviewer_/);
  });

  it("correctly resolves caller identity from tokens", () => {
    const creds = ensureCredentials(testConfig, credPath);
    expect(resolveCallerFromToken(creds.adminToken, creds)).toEqual({ type: "admin" });
    expect(resolveCallerFromToken(creds.roleTokens.architect, creds)).toEqual({
      type: "role",
      roleId: "architect",
    });
    expect(resolveCallerFromToken(creds.roleTokens.developer, creds)).toEqual({
      type: "role",
      roleId: "developer",
    });
    expect(resolveCallerFromToken("invalid_token", creds)).toBeNull();
    expect(resolveCallerFromToken("", creds)).toBeNull();
  });
});

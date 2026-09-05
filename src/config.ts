import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { AgentCorpError, invariant } from "./errors.js";
import { OrgConfigSchema, type OrgConfig } from "./types.js";

export function parseOrgConfig(raw: string): OrgConfig {
  const result = OrgConfigSchema.safeParse(parse(raw));
  if (!result.success) {
    throw new AgentCorpError(
      "INVALID_CONFIG",
      `Invalid org.toml:\n${result.error.issues
        .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const ids = new Set(result.data.roles.map((role) => role.id));
  invariant(ids.size === result.data.roles.length, "INVALID_CONFIG", "Role IDs must be unique");
  for (const role of result.data.roles) {
    for (const peer of role.allowed_peers) {
      invariant(ids.has(peer), "INVALID_CONFIG", `Role ${role.id} references unknown peer ${peer}`);
    }
    if (role.artifact_visibility !== "all") {
      for (const visibleRole of role.artifact_visibility) {
        invariant(
          ids.has(visibleRole),
          "INVALID_CONFIG",
          `Role ${role.id} grants artifact visibility to unknown role ${visibleRole}`,
        );
      }
    }
  }

  if (result.data.limits?.default_page_size !== undefined && result.data.limits?.max_page_size !== undefined) {
    invariant(
      result.data.limits.default_page_size <= result.data.limits.max_page_size,
      "INVALID_CONFIG",
      "default_page_size cannot be greater than max_page_size",
    );
  }

  return result.data;
}

export function loadOrgConfig(path = "org.toml"): OrgConfig {
  const absolutePath = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new AgentCorpError(
      "CONFIG_NOT_FOUND",
      `Could not read organization configuration at ${absolutePath}: ${String(error)}`,
    );
  }

  return parseOrgConfig(raw);
}

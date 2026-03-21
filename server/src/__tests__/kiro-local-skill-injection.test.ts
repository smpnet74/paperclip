import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureKiroSkillsInjected, cleanupKiroSkills } from "@paperclipai/adapter-kiro-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Create a mock Paperclip repo layout with skills.
 *
 * listPaperclipSkillEntries walks up from moduleDir looking for a `skills/`
 * directory at `../../skills` relative to moduleDir. We create the directory
 * structure to satisfy that resolution.
 */
async function createSkillSource(root: string, skillName: string, content: string) {
  const skillDir = path.join(root, "skills", skillName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
}

describe("kiro local adapter skill injection", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("writes Paperclip skills as SKILL.md files with YAML frontmatter", async () => {
    const root = await makeTempDir("paperclip-kiro-skills-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-skills-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    // moduleDir is at root/a/b so ../../skills resolves to root/skills
    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nInteract with Paperclip.");
    await createSkillSource(root, "paperclip-create-agent", "# Create Agent\n\nCreate new agents.");

    const logs: string[] = [];
    await ensureKiroSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      { skillsHome, moduleDir },
    );

    // Verify skills were written as SKILL.md files (not symlinks)
    const skillFileA = path.join(skillsHome, "paperclip", "SKILL.md");
    const skillFileB = path.join(skillsHome, "paperclip-create-agent", "SKILL.md");
    const contentA = await fs.readFile(skillFileA, "utf8");
    const contentB = await fs.readFile(skillFileB, "utf8");

    // Check YAML frontmatter structure
    expect(contentA).toMatch(/^---\nname: paperclip\ndescription: /);
    expect(contentA).toContain("Interact with Paperclip.");
    expect(contentB).toMatch(/^---\nname: paperclip-create-agent\ndescription: /);
    expect(contentB).toContain("Create new agents.");

    // Check managed marker exists
    const markerA = path.join(skillsHome, "paperclip", ".paperclip-managed");
    const markerB = path.join(skillsHome, "paperclip-create-agent", ".paperclip-managed");
    expect(await fs.stat(markerA).then(() => true)).toBe(true);
    expect(await fs.stat(markerB).then(() => true)).toBe(true);

    // Check injection was logged
    expect(logs.some((line) => line.includes("Injected Kiro skill: paperclip"))).toBe(true);
    expect(logs.some((line) => line.includes("Injected Kiro skill: paperclip-create-agent"))).toBe(true);
  });

  it("skips user-owned skills that are not Paperclip-managed", async () => {
    const root = await makeTempDir("paperclip-kiro-preserve-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-preserve-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nContent.");

    // Create a user-owned skill at the same path (no managed marker)
    const userSkillDir = path.join(skillsHome, "paperclip");
    await fs.mkdir(userSkillDir, { recursive: true });
    await fs.writeFile(path.join(userSkillDir, "SKILL.md"), "user content", "utf8");

    const logs: string[] = [];
    await ensureKiroSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      { skillsHome, moduleDir },
    );

    // User's skill should be preserved
    const content = await fs.readFile(path.join(userSkillDir, "SKILL.md"), "utf8");
    expect(content).toBe("user content");
    expect(logs.some((line) => line.includes("already exists and is not Paperclip-managed"))).toBe(true);
  });

  it("cleans up Paperclip-managed skills after execution", async () => {
    const root = await makeTempDir("paperclip-kiro-cleanup-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-cleanup-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nContent.");

    // First inject
    await ensureKiroSkillsInjected(async () => {}, { skillsHome, moduleDir });

    // Verify skill was created
    expect(await fs.stat(path.join(skillsHome, "paperclip", "SKILL.md")).then(() => true)).toBe(true);

    // Now cleanup
    const logs: string[] = [];
    await cleanupKiroSkills(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      { skillsHome, moduleDir },
    );

    // Skill directory should be removed
    await expect(fs.stat(path.join(skillsHome, "paperclip"))).rejects.toThrow();
    expect(logs.some((line) => line.includes("Cleaned up Kiro skill: paperclip"))).toBe(true);
  });

  it("does not clean up user-owned skills", async () => {
    const root = await makeTempDir("paperclip-kiro-noclean-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-noclean-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    await createSkillSource(root, "paperclip", "# Paperclip Skill\n\nContent.");

    // Create a user-owned skill (no managed marker)
    const userSkillDir = path.join(skillsHome, "paperclip");
    await fs.mkdir(userSkillDir, { recursive: true });
    await fs.writeFile(path.join(userSkillDir, "SKILL.md"), "user content", "utf8");

    await cleanupKiroSkills(async () => {}, { skillsHome, moduleDir });

    // User's skill should still exist
    const content = await fs.readFile(path.join(userSkillDir, "SKILL.md"), "utf8");
    expect(content).toBe("user content");
  });

  it("handles missing skills directory gracefully", async () => {
    const root = await makeTempDir("paperclip-kiro-empty-src-");
    const skillsHome = await makeTempDir("paperclip-kiro-empty-home-");
    cleanupDirs.add(root);
    cleanupDirs.add(skillsHome);

    // moduleDir without any skills directory
    const moduleDir = path.join(root, "a", "b");
    await fs.mkdir(moduleDir, { recursive: true });

    // Should not throw
    await ensureKiroSkillsInjected(async () => {}, { skillsHome, moduleDir });
    await cleanupKiroSkills(async () => {}, { skillsHome, moduleDir });
  });
});

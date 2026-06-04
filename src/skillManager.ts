import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface Skill {
  name: string;
  description: string;
  displayName: string;
  shortDescription: string;
  skillPath: string;
  skillMdPath: string;
  isSystem: boolean;
}

export interface SkillDetails extends Skill {
  body: string;
  references: string[];
  scripts: string[];
}

/** Logical components that make up a skill's instruction body */
export interface SkillComponents {
  persona: string;       // "You are acting as a ..."
  methodology: string;   // Steps / approach
  outputFormat: string;  // How to structure the response
  rules: string;         // Key rules / constraints
  extraSections: string; // Any other markdown sections
}

export const SKILLS_DIR = path.join(
  os.homedir(),
  '.config',
  'qgenie-cli',
  'agent',
  'skills'
);
const SYSTEM_SKILLS_DIR = path.join(SKILLS_DIR, '.system');

function parseSkillMd(content: string): {
  name: string;
  description: string;
  body: string;
} {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { name: '', description: '', body: content };
  }
  const frontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*([\s\S]*?)(?=\n\w|\n---|\s*$)/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim().replace(/\n\s+/g, ' ') : '',
    body,
  };
}

/** @deprecated Use parseOpenAiYamlAsync instead. Kept for sync callers. */
function parseOpenAiYaml(yamlPath: string): {
  displayName: string;
  shortDescription: string;
} {
  try {
    const content = fs.readFileSync(yamlPath, 'utf8');
    const displayNameMatch = content.match(/display_name:\s*["']?([^"'\n]+)["']?/);
    const shortDescMatch = content.match(/short_description:\s*["']?([^"'\n]+)["']?/);
    return {
      displayName: displayNameMatch ? displayNameMatch[1].trim() : '',
      shortDescription: shortDescMatch ? shortDescMatch[1].trim() : '',
    };
  } catch {
    return { displayName: '', shortDescription: '' };
  }
}

/**
 * Parse a skill body into logical components by looking for known section headings.
 * Falls back gracefully if sections are missing.
 */
/** Known section keys used to identify standard skill components */
const knownKeys = ['persona', 'role', 'methodology', 'approach', 'steps',
  'output', 'format', 'rules', 'constraints', 'key rules'];

export function parseSkillComponents(body: string): SkillComponents {
  const sections: Record<string, string> = {};
  const lines = body.split('\n');
  let currentSection = '__preamble__';
  let buffer: string[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      sections[currentSection] = buffer.join('\n').trim();
      currentSection = h2[1].toLowerCase();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  sections[currentSection] = buffer.join('\n').trim();

  const findSection = (...keys: string[]): string => {
    for (const key of keys) {
      const match = Object.entries(sections).find(([k, v]) => k.includes(key) && v);
      if (match) { return match[1]; }
    }
    return '';
  };

  const persona = findSection('persona', 'role');
  const methodology = findSection('methodology', 'approach', 'steps', 'process');
  const outputFormat = findSection('output format', 'output', 'format', 'response format');
  const rules = findSection('key rules', 'rules', 'constraints', 'important');

  const extraParts: string[] = [];
  for (const [k, v] of Object.entries(sections)) {
    if (k === '__preamble__') {
      continue;
    }
    const isKnown = knownKeys.some((kk) => k.includes(kk));
    if (!isKnown && v) {
      extraParts.push(`## ${k.charAt(0).toUpperCase() + k.slice(1)}\n${v}`);
    }
  }

  return {
    persona: persona || (sections['__preamble__'] || ''),
    methodology,
    outputFormat,
    rules,
    extraSections: extraParts.join('\n\n'),
  };
}

/**
 * Build a SKILL.md body from logical components.
 */
function buildSkillBody(
  skillName: string,
  components: SkillComponents
): string {
  const parts: string[] = [`# ${skillName}`];

  if (components.persona) {
    parts.push(`## Persona & Role\n${components.persona}`);
  }
  if (components.methodology) {
    parts.push(`## Methodology\n${components.methodology}`);
  }
  if (components.outputFormat) {
    parts.push(`## Output Format\n${components.outputFormat}`);
  }
  if (components.rules) {
    parts.push(`## Key Rules\n${components.rules}`);
  }
  if (components.extraSections) {
    parts.push(components.extraSections);
  }

  return parts.join('\n\n');
}

/** @deprecated Use loadSkillsFromDirAsync instead. Kept for sync callers. */
function loadSkillsFromDir(dir: string, isSystem: boolean): Skill[] {
  const skills: Skill[] = [];
  if (!fs.existsSync(dir)) {
    return skills;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const skillPath = path.join(dir, entry.name);
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      continue;
    }
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const { name, description } = parseSkillMd(content);
    const openAiYamlPath = path.join(skillPath, 'agents', 'openai.yaml');
    const { displayName, shortDescription } = parseOpenAiYaml(openAiYamlPath);
    skills.push({
      name: name || entry.name,
      description,
      displayName: displayName || name || entry.name,
      shortDescription: shortDescription || description.substring(0, 80),
      skillPath,
      skillMdPath,
      isSystem,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** @deprecated Use loadSkillsAsync instead. Kept for sync callers in agentSession/chatViewProvider. */
export function loadSkills(): Skill[] {
  return loadSkillsFromDir(SKILLS_DIR, false);
}

/** @deprecated Use loadSystemSkillsAsync instead. Kept for sync callers in agentSession/chatViewProvider. */
export function loadSystemSkills(): Skill[] {
  return loadSkillsFromDir(SYSTEM_SKILLS_DIR, true);
}

export function loadSkillDetails(skill: Skill): SkillDetails {
  const content = fs.readFileSync(skill.skillMdPath, 'utf8');
  const { body } = parseSkillMd(content);
  const referencesDir = path.join(skill.skillPath, 'references');
  const scriptsDir = path.join(skill.skillPath, 'scripts');
  const references = fs.existsSync(referencesDir)
    ? fs.readdirSync(referencesDir).filter((f: string) => !f.startsWith('.'))
    : [];
  const scripts = fs.existsSync(scriptsDir)
    ? fs.readdirSync(scriptsDir).filter((f: string) => !f.startsWith('.'))
    : [];
  return { ...skill, body, references, scripts };
}

/** Build the SKILL.md frontmatter block. */
function buildSkillFrontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
}

/** Build the openai.yaml content for a skill. */
function buildOpenAiYaml(displayName: string, shortDescription: string, toolName: string): string {
  return `interface:\n  display_name: "${displayName}"\n  short_description: "${shortDescription}"\n  default_prompt: "Use $${toolName} to "\n`;
}

export function createSkill(
  name: string,
  description: string,
  displayName: string,
  shortDescription: string,
  components: SkillComponents
): string {
  const skillDir = path.join(SKILLS_DIR, name);
  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill "${name}" already exists.`);
  }
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'agents'), { recursive: true });

  const dn = displayName || name;
  const sd = shortDescription || description.substring(0, 64);
  const body = buildSkillBody(dn, components);
  const skillMd = buildSkillFrontmatter(name, description) + `${body}\n`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');

  const openAiYaml = buildOpenAiYaml(dn, sd, name);
  fs.writeFileSync(path.join(skillDir, 'agents', 'openai.yaml'), openAiYaml, 'utf8');

  return skillDir;
}

export function updateSkill(
  skill: Skill,
  description: string,
  displayName: string,
  shortDescription: string,
  components: SkillComponents
): void {
  const dn = displayName || skill.name;
  const sd = shortDescription || description.substring(0, 64);
  const body = buildSkillBody(dn, components);
  const skillMd = buildSkillFrontmatter(skill.name, description) + `${body}\n`;
  fs.writeFileSync(skill.skillMdPath, skillMd, 'utf8');

  fs.mkdirSync(path.join(skill.skillPath, 'agents'), { recursive: true });
  const openAiYamlPath = path.join(skill.skillPath, 'agents', 'openai.yaml');
  const openAiYaml = buildOpenAiYaml(dn, sd, skill.name);
  fs.writeFileSync(openAiYamlPath, openAiYaml, 'utf8');
}

export function deleteSkill(skill: Skill): void {
  if (skill.isSystem) {
    throw new Error('Cannot delete system skills.');
  }
  fs.rmSync(skill.skillPath, { recursive: true, force: true });
}

// ─── Skill Content Cache ────────────────────────────────────────────────────
const skillCache = new Map<string, { body: string; mtime: number }>();

/**
 * Retrieve a skill's parsed body, using an mtime-based cache to avoid
 * unnecessary re-reads of unchanged files.
 */
async function getCachedSkillBody(skillMdPath: string): Promise<string> {
  const stat = await fsp.stat(skillMdPath);
  const mtimeMs = stat.mtimeMs;
  const cached = skillCache.get(skillMdPath);
  if (cached && cached.mtime === mtimeMs) {
    return cached.body;
  }
  const content = await fsp.readFile(skillMdPath, 'utf8');
  const { body } = parseSkillMd(content);
  skillCache.set(skillMdPath, { body, mtime: mtimeMs });
  return body;
}

/**
 * Build a skill invocation string with mtime-cached body lookup.
 */
export async function buildSkillInvocationAsync(skill: Skill, userTask: string): Promise<string> {
  const body = await getCachedSkillBody(skill.skillMdPath);
  const taskLine = userTask ? `\n\n---\n\nTask: ${userTask}` : '';
  return `[Skill: $${skill.name}]\n\n${body}${taskLine}`;
}

// ─── Async I/O variants ─────────────────────────────────────────────────────

async function parseOpenAiYamlAsync(yamlPath: string): Promise<{
  displayName: string;
  shortDescription: string;
}> {
  try {
    const content = await fsp.readFile(yamlPath, 'utf8');
    const displayNameMatch = content.match(/display_name:\s*["']?([^"'\n]+)["']?/);
    const shortDescMatch = content.match(/short_description:\s*["']?([^"'\n]+)["']?/);
    return {
      displayName: displayNameMatch ? displayNameMatch[1].trim() : '',
      shortDescription: shortDescMatch ? shortDescMatch[1].trim() : '',
    };
  } catch {
    return { displayName: '', shortDescription: '' };
  }
}

async function loadSkillsFromDirAsync(dir: string, isSystem: boolean): Promise<Skill[]> {
  try {
    await fsp.access(dir);
  } catch {
    return [];
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  const skills = await Promise.all(
    skillDirs.map(async (entry) => {
      const skillPath = path.join(dir, entry.name);
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      try {
        const content = await fsp.readFile(skillMdPath, 'utf8');
        const { name, description } = parseSkillMd(content);
        const openAiYamlPath = path.join(skillPath, 'agents', 'openai.yaml');
        const { displayName, shortDescription } = await parseOpenAiYamlAsync(openAiYamlPath);
        return {
          name: name || entry.name,
          description,
          displayName: displayName || name || entry.name,
          shortDescription: shortDescription || description.substring(0, 80),
          skillPath,
          skillMdPath,
          isSystem,
        } as Skill;
      } catch {
        return null;
      }
    })
  );

  return skills
    .filter((s): s is Skill => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSkillsAsync(): Promise<Skill[]> {
  return loadSkillsFromDirAsync(SKILLS_DIR, false);
}

export async function loadSystemSkillsAsync(): Promise<Skill[]> {
  return loadSkillsFromDirAsync(SYSTEM_SKILLS_DIR, true);
}



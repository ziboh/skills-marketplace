#!/usr/bin/env node

/**
 * generate-marketplace.mjs
 *
 * 从 VoltAgent/awesome-agent-skills 的 README.md 提取所有技能条目，
 * 生成 Skill Hub 兼容的 marketplace.json。
 *
 * 用法: node scripts/generate-marketplace.mjs
 * 输出: marketplace.json (写入项目根目录)
 *
 * 依赖: Node.js 18+ (原生 fetch) 或 curl
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const README_URL = 'https://raw.githubusercontent.com/VoltAgent/awesome-agent-skills/main/README.md';
const OUTPUT = path.join(ROOT, 'marketplace.json');

// ── Helpers ──

/** 从 section title 中提取组织/作者名 */
function inferAuthor(title) {
  let clean = title.replace(/<[^>]+>/g, '').trim();
  // Clean up leading dash-space: "Skills by - X - Y" → "Skills by Y"
  clean = clean.replace(/^Skills\s+by\s+-\s+(.+?)\s+-\s+(.+)/i, (_, _skip, main) => `Skills by ${main}`);

  // "Product Manager Skills by Dean Peters" → "Dean Peters"
  let m = clean.match(/(?:Product Manager|Product Management|Marketing|Advertising|Security)\s+Skills?\s+by\s+(.+)/i);
  if (m) return m[1].trim();

  // "Skills by Stripe Team" → "Stripe Team" (Team suffix only at end)
  m = clean.match(/^Skills?\s+by\s+(.+?)(?:\s+Team\s+for\s+their\s+|$)/i);
  if (m) return m[1].trim();

  // "Skills by Stripe Team" → "Stripe" (trailing Team)
  m = clean.match(/^Skills?\s+by\s+(.+?)\s+Team\s*$/i);
  if (m) return m[1].trim();

  // "Skills by Stripe" → "Stripe" (no suffix)
  m = clean.match(/^Skills?\s+by\s+(.+)/i);
  if (m) return m[1].trim();

  // "Official Claude Skills" → ""
  m = clean.match(/^Official\s+(.+)\s+Skills/i);
  if (m) return '';

  // Community sections like "Marketing", "Vector Databases" → ""
  return '';
}

/** 从 section title 提取短标签（用作搜索关键词） */
function sectionTag(title) {
  let clean = title.replace(/<[^>]+>/g, '').trim();
  // "Skills by - X - Y" → "Skills by Y"
  clean = clean.replace(/^Skills\s+by\s+-\s+(.+?)\s+-\s+(.+)/i, (_, _skip, main) => `Skills by ${main}`);
  const lower = clean.toLowerCase();

  // "Skills by Stripe Team for Terraform" → "stripe"
  let m = lower.match(/^skills?\s+by\s+(.+?)(?:\s+team\s+for|\s+for|$)/);
  if (m) return m[1].trim();

  // "Skills by Stripe Team" → "stripe"
  m = lower.match(/^skills?\s+by\s+(.+?)\s+team\s*$/);
  if (m) return m[1].trim();

  // "Skills by Stripe" → "stripe"
  m = lower.match(/^skills?\s+by\s+(.+)/);
  if (m) return m[1].trim();

  // "Official Claude Skills" → "claude"
  m = lower.match(/^official\s+(.+?)\s+skills?$/);
  if (m) return m[1].trim();

  // "Marketing Skills by Corey Haines" → "corey haines"
  m = lower.match(/^(?:marketing|advertising|security|product manager|product management)\s+skills?\s+by\s+(.+)/);
  if (m) return m[1].trim();

  // ".NET Skills", "Python Skills" (sub-sections within org) → keep
  // Community: "Vector Databases", "Marketing" → keep
  return clean;
}

// ── README fetching ──

async function fetchReadme() {
  // Try native fetch first (Node.js 18+)
  try {
    const resp = await fetch(README_URL, { signal: AbortSignal.timeout(15000) });
    if (resp.ok) return await resp.text();
  } catch { /* fall through */ }

  // Try curl
  try {
    const tmp = path.join(ROOT, '.readme-tmp.md');
    execSync(`curl -sL --connect-timeout 10 --max-time 30 "${README_URL}" -o "${tmp}"`, { stdio: 'pipe' });
    const md = fs.readFileSync(tmp, 'utf-8');
    fs.unlinkSync(tmp);
    if (md.length > 1000) return md;
  } catch { /* fall through */ }

  // Local cache fallback (for offline testing)
  const local = path.join(ROOT, '.readme-cache.md');
  if (fs.existsSync(local)) {
    console.warn('  ⚠ Using local cache .readme-cache.md (may be stale)');
    return fs.readFileSync(local, 'utf-8');
  }

  throw new Error('Cannot fetch README - no network available\n' +
    '  Tip: save a cached copy as .readme-cache.md and re-run');
}

// ── Parsing ──

function parseSections(md) {
  const sections = [];
  const re = /<details\s*[^>]*>([\s\S]*?)<\/details>/g;
  let match;

  while ((match = re.exec(md)) !== null) {
    const block = match[1];
    const sm = block.match(/<summary>(?:<[^>]+>)?\s*([\s\S]*?)(?:<\/[^>]+>)?\s*<\/summary>/i);
    if (!sm) continue;
    const title = sm[1].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;

    const cstart = block.indexOf('</summary>');
    const content = cstart >= 0 ? block.slice(cstart + 10) : block;
    sections.push({ title, content });
  }
  return sections;
}

function parseEntries(content, sectionTitle) {
  const entries = [];
  const lines = content.split('\n');
  let subCat = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Sub-category headers: "### CUDA-Q" or "**From [repo]:**"
    const h = line.match(/^#{2,4}\s+(.+)/);
    if (h) { subCat = h[1].replace(/<[^>]+>/g, '').trim(); continue; }
    const b = line.match(/^\*{2}From\s+(?:the\s+)?([^*]+)\*{2}\s*:/);
    if (b) { subCat = b[1].replace(/<[^>]+>/g, '').trim(); continue; }

    // Skill entry: - **[name](url)** - description
    const e = line.match(/^\s*-\s+\*\*\[([^\]]+)\]\(([^)]+)\)\*\*(?:\s*[-–—]\s*(.*))?$/);
    if (!e) continue;

    const display = e[1].trim();
    const url = e[2].trim();
    const desc = (e[3] || '').trim();
    const repo = display;

    entries.push({ name: display, description: desc, url, repo, subCat });
  }

  return entries;
}

function deduplicate(entries) {
  const seen = new Map();
  const result = [];
  for (const e of entries) {
    const key = e.name;
    const existing = seen.get(key);
    if (existing) {
      if (e.subCat && !existing.subCat) existing.subCat = e.subCat;
      continue;
    }
    seen.set(key, e);
    result.push(e);
  }
  return result;
}

// ── Main ──

async function main() {
  console.log('Fetching README...');
  const md = await fetchReadme();
  console.log(`  ${(md.length / 1024).toFixed(1)} KB`);

  console.log('Parsing sections...');
  const sections = parseSections(md);
  console.log(`  ${sections.length} sections`);

  // Collect entries
  const raw = [];
  for (const s of sections) {
    const orgTag = sectionTag(s.title);
    const author = inferAuthor(s.title);
    const entries = parseEntries(s.content, s.title);
    for (const e of entries) {
      e.org = orgTag;
      e.author = author;
      e.sectionTitle = s.title;
    }
    raw.push(...entries);
    if (entries.length > 0) {
      console.log(`  ${s.title}: ${entries.length}`);
    }
  }
  console.log(`\nRaw entries: ${raw.length}`);

  // Dedup
  const deduped = deduplicate(raw);
  console.log(`After dedup: ${deduped.length} (${raw.length - deduped.length} removed)`);

  // Build final skills list
  const skills = deduped.map(e => {
    const slashIdx = e.name.indexOf('/');
    const cleanName = slashIdx > 0 ? e.name.slice(slashIdx + 1) : e.name;
    return {
      name: cleanName,
      description: e.description,
      tags: [],
      ...(e.repo ? { repo: e.repo } : {}),
      homepage: e.url,
      ...(e.author ? { author: e.author } : {}),
    };
  });

  const withR = skills.filter(s => s.repo).length;
  const out = {
    name: 'awesome-agent-skills',
    owner: { name: 'VoltAgent', url: 'https://github.com/VoltAgent/awesome-agent-skills' },
    metadata: {
      description: 'Hand-picked Agent Skills from leading development teams and the community',
      source: README_URL,
    },
    generatedAt: new Date().toISOString(),
    total: skills.length,
    stats: { withRepo: withR, withoutRepo: skills.length - withR },
    skills,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2), 'utf-8');

  const kb = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
  console.log(`\n✓ Written to ${OUTPUT}`);
  console.log(`  ${skills.length} skills (${withR} with repo, ${skills.length - withR} without)`);
  console.log(`  ${kb} KB`);
}

main().catch(err => {
  console.error(`\n✗ Fatal: ${err.message}`);
  process.exit(1);
});

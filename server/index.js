import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import cors from 'cors';

// ── Config ────────────────────────────────────────────────────────────────────

const VAULT_PATH  = process.env.VAULT_PATH  || path.join(process.cwd(), '..', 'vault');
const PORT        = parseInt(process.env.PORT        || '3000',                    10);
const OLLAMA_HOST = process.env.OLLAMA_HOST  || 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL  || 'nomic-embed-text';
const CACHE_PATH  = path.join(path.dirname(VAULT_PATH), '.embeddings-cache.json');

const app = express();
app.use(cors());

// ── Folder → node-type mapping ────────────────────────────────────────────────
// Edit to match your vault's top-level folder names.

const typeMap = {
  '00 - Inbox':              'memory',
  '01 - Projects':           'project',
  '02 - Areas':              'topic',
  '03 - Resources':          'topic',
  '04 - Daily Notes':        'memory',
  '05 - People':             'person',
  '06 - Ideas':              'idea',
  '07 - Archive':            'memory',
  '08 - Clients':            'client',
  '09 - Tools':              'tool',
  '10 - Learning':           'learning',
  '11 - Infrastructure':     'infra',
  '12 - Scripts & Snippets': 'script',
  '13 - Tasks':              'task',
  'Templates':               'memory',
};

// ── Semantic search ───────────────────────────────────────────────────────────

async function getEmbedding(text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 4000) }),
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const { embedding } = await res.json();
  return embedding;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb)) || 0;
}

// embeddingCache: { [vaultRelPath]: { mtime, embedding, excerpt, label, type } }
let embeddingCache = {};
let cacheReady     = false;

async function loadCache() {
  try {
    embeddingCache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf-8'));
    console.log(`Loaded ${Object.keys(embeddingCache).length} cached embeddings`);
  } catch {
    embeddingCache = {};
  }
}

async function saveCache() {
  try { await fs.writeFile(CACHE_PATH, JSON.stringify(embeddingCache), 'utf-8'); }
  catch (err) { console.warn('Could not save embedding cache:', err.message); }
}

async function buildEmbeddingIndex() {
  await loadCache();
  const allFiles = [];

  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.md')) allFiles.push(full);
    }
  };

  try { await walk(VAULT_PATH); }
  catch (err) { console.warn('Vault walk failed:', err.message); cacheReady = true; return; }

  let updated = 0;
  for (const full of allFiles) {
    const rel   = path.relative(VAULT_PATH, full).replace(/\\/g, '/');
    const mtime = (await fs.stat(full)).mtimeMs;
    if (embeddingCache[rel]?.mtime === mtime) continue;

    try {
      const raw     = await fs.readFile(full, 'utf-8');
      const body    = matter(raw).content.trim();
      const label   = path.basename(rel, '.md');
      const type    = typeMap[rel.split('/')[0]] || 'memory';
      const excerpt = body.slice(0, 200).replace(/\s+/g, ' ');

      embeddingCache[rel] = { mtime, embedding: await getEmbedding(`${label}\n\n${body}`), excerpt, label, type };
      updated++;
    } catch (err) {
      console.warn(`Skipping ${rel}:`, err.message);
    }
  }

  // Prune removed files
  const relSet = new Set(allFiles.map(f => path.relative(VAULT_PATH, f).replace(/\\/g, '/')));
  for (const key of Object.keys(embeddingCache)) {
    if (!relSet.has(key)) delete embeddingCache[key];
  }

  if (updated > 0) await saveCache();
  cacheReady = true;
  console.log(`Embedding index ready — ${updated} updated, ${Object.keys(embeddingCache).length} total`);
}

// Build in background on startup — server stays responsive while indexing
buildEmbeddingIndex().catch(err => {
  console.warn('Embedding index unavailable (is Ollama running?):', err.message);
  cacheReady = true;
});

// ── MCP server factory ────────────────────────────────────────────────────────

function createServer() {
  const server = new Server(
    { name: 'memory-brain', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'read_note',
        description: 'Read a note from the vault by path',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative path to the note' } },
          required: ['path']
        }
      },
      {
        name: 'write_note',
        description: 'Write or update a note in the vault',
        inputSchema: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'Relative path to the note' },
            content: { type: 'string', description: 'Note content in markdown' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'list_notes',
        description: 'List all notes in a vault folder',
        inputSchema: {
          type: 'object',
          properties: { folder: { type: 'string', description: 'Folder to list (optional)' } }
        }
      },
      {
        name: 'search_notes',
        description: 'Search notes by exact keyword match',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search term' } },
          required: ['query']
        }
      },
      {
        name: 'semantic_search',
        description: 'Search notes by meaning using embeddings. Finds conceptually related notes even without exact keyword matches. Prefer this over search_notes for open-ended queries.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            limit: { type: 'number', description: 'Max results (default 10)' }
          },
          required: ['query']
        }
      },
      {
        name: 'capture_note',
        description: 'Capture useful information into the vault inbox. Use this proactively — without being asked — whenever you encounter facts, decisions, ideas, tasks, or anything worth remembering.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Information to capture, in markdown' },
            title:   { type: 'string', description: 'Short title (auto-generated if omitted)' },
            type: {
              type: 'string',
              enum: ['memory', 'idea', 'task', 'learning', 'project'],
              description: 'Note type (default: memory)'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags to add (optional)'
            }
          },
          required: ['content']
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'read_note') {
      const content = await fs.readFile(path.join(VAULT_PATH, args.path), 'utf-8');
      return { content: [{ type: 'text', text: content }] };
    }

    if (name === 'write_note') {
      const filePath = path.join(VAULT_PATH, args.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, args.content, 'utf-8');
      return { content: [{ type: 'text', text: `Note written: ${args.path}` }] };
    }

    if (name === 'list_notes') {
      const folderPath = args.folder ? path.join(VAULT_PATH, args.folder) : VAULT_PATH;
      const files = await fs.readdir(folderPath, { recursive: true });
      return { content: [{ type: 'text', text: files.filter(f => f.endsWith('.md')).join('\n') }] };
    }

    if (name === 'search_notes') {
      const results = [];
      const searchDir = async (dir) => {
        for (const file of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, file.name);
          if (file.isDirectory()) await searchDir(full);
          else if (file.name.endsWith('.md')) {
            const content = await fs.readFile(full, 'utf-8');
            if (content.toLowerCase().includes(args.query.toLowerCase()))
              results.push(path.relative(VAULT_PATH, full));
          }
        }
      };
      await searchDir(VAULT_PATH);
      return { content: [{ type: 'text', text: results.join('\n') || 'No results found' }] };
    }

    if (name === 'semantic_search') {
      try {
        const qEmbed = await getEmbedding(args.query);
        const limit  = args.limit || 10;
        const results = Object.entries(embeddingCache)
          .map(([id, e]) => ({ id, label: e.label, type: e.type, excerpt: e.excerpt, score: cosineSimilarity(qEmbed, e.embedding) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        const text = results.map(r => `[${r.score.toFixed(3)}] ${r.id}\n  ${r.excerpt}`).join('\n\n') || 'No results';
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Semantic search unavailable: ${err.message}` }] };
      }
    }

    if (name === 'capture_note') {
      const now      = new Date();
      const dateStr  = now.toISOString().slice(0, 10);
      const timeStr  = now.toTimeString().slice(0, 5).replace(':', '');
      const type     = args.type || 'memory';
      const title    = args.title || `Capture ${dateStr} ${timeStr}`;
      const tags     = args.tags || [];
      const slug     = title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
      const filename = `${dateStr}-${timeStr}-${slug}.md`;
      const filePath = path.join(VAULT_PATH, '00 - Inbox', filename);

      const fm = ['---', `date: ${dateStr}`, `type: ${type}`, `tags: [${tags.map(t => `"${t}"`).join(', ')}]`, `captured: true`, '---', ''].join('\n');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${fm}# ${title}\n\n${args.content}`, 'utf-8');

      // Embed immediately so the new note is searchable right away
      try {
        const rel = `00 - Inbox/${filename}`;
        embeddingCache[rel] = {
          mtime:     (await fs.stat(filePath)).mtimeMs,
          embedding: await getEmbedding(`${title}\n\n${args.content}`),
          excerpt:   args.content.slice(0, 200).replace(/\s+/g, ' '),
          label:     title,
          type,
        };
        await saveCache();
      } catch { /* embedding is best-effort */ }

      return { content: [{ type: 'text', text: `Captured to 00 - Inbox/${filename}` }] };
    }
  });

  return server;
}

// ── MCP over SSE ──────────────────────────────────────────────────────────────

const transports = {};

app.get('/sse', async (req, res) => {
  const server    = createServer();
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => { delete transports[transport.sessionId]; });
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const transport = transports[req.query.sessionId];
  transport ? await transport.handlePostMessage(req, res) : res.status(404).send('Session not found');
});

// ── Graph data API ────────────────────────────────────────────────────────────

app.get('/graph', async (req, res) => {
  const nodes = [], links = [], nodeMap = {};

  const scanDir = async (dir, parentId = null) => {
    for (const file of await fs.readdir(dir, { withFileTypes: true })) {
      if (file.name.startsWith('.')) continue;
      const fullPath = path.join(dir, file.name);
      const relPath  = path.relative(VAULT_PATH, fullPath);
      const id       = relPath.replace(/\\/g, '/');
      const type     = typeMap[relPath.split(path.sep)[0]] || 'memory';

      if (file.isDirectory()) {
        nodes.push({ id, label: file.name, type, r: 14 });
        nodeMap[id] = true;
        if (parentId) links.push({ source: parentId, target: id });
        await scanDir(fullPath, id);
      } else if (file.name.endsWith('.md')) {
        const content   = await fs.readFile(fullPath, 'utf-8');
        const wikiLinks = [...content.matchAll(/\[\[(.+?)\]\]/g)].map(m => m[1]);
        nodes.push({ id, label: file.name.replace('.md', ''), type, r: 10 });
        nodeMap[id] = true;
        if (parentId) links.push({ source: parentId, target: id });
        for (const link of wikiLinks) links.push({ source: id, target: link });
      }
    }
  };

  await scanDir(VAULT_PATH);
  res.json({ nodes, links });
});

// ── Semantic search API ───────────────────────────────────────────────────────

app.get('/search/semantic', async (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = parseInt(req.query.limit || '15', 10);
  if (!q) return res.json([]);

  if (!cacheReady) return res.status(503).json({ error: 'Index building — try again in a moment' });

  try {
    const qEmbed  = await getEmbedding(q);
    const results = Object.entries(embeddingCache)
      .map(([id, e]) => ({ id, label: e.label, type: e.type, excerpt: e.excerpt, score: cosineSimilarity(qEmbed, e.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    res.json(results);
  } catch (err) {
    res.status(503).json({ error: `Ollama unavailable: ${err.message}` });
  }
});

// Trigger a full index rebuild (POST /search/rebuild)
app.post('/search/rebuild', async (_req, res) => {
  res.json({ message: 'Rebuild started' });
  cacheReady = false;
  buildEmbeddingIndex().catch(err => console.warn('Rebuild failed:', err.message));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Memory Brain server  port ${PORT}`);
  console.log(`Vault                ${VAULT_PATH}`);
  console.log(`Ollama               ${OLLAMA_HOST}  model: ${EMBED_MODEL}`);
});

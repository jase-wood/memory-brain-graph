import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import cors from 'cors';

const VAULT_PATH = process.env.VAULT_PATH || path.join(process.cwd(), '..', 'vault');
const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
app.use(cors());

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
          properties: {
            path: { type: 'string', description: 'Relative path to the note' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_note',
        description: 'Write or update a note in the vault',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the note' },
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
          properties: {
            folder: { type: 'string', description: 'Folder to list (optional)' }
          }
        }
      },
      {
        name: 'search_notes',
        description: 'Search notes by keyword',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term' }
          },
          required: ['query']
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'read_note') {
      const filePath = path.join(VAULT_PATH, args.path);
      const content = await fs.readFile(filePath, 'utf-8');
      return { content: [{ type: 'text', text: content }] };
    }

    if (name === 'write_note') {
      const filePath = path.join(VAULT_PATH, args.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, args.content, 'utf-8');
      return { content: [{ type: 'text', text: `Note written: ${args.path}` }] };
    }

    if (name === 'list_notes') {
      const folderPath = args.folder
        ? path.join(VAULT_PATH, args.folder)
        : VAULT_PATH;
      const files = await fs.readdir(folderPath, { recursive: true });
      const notes = files.filter(f => f.endsWith('.md'));
      return { content: [{ type: 'text', text: notes.join('\n') }] };
    }

    if (name === 'search_notes') {
      const results = [];
      const searchDir = async (dir) => {
        const files = await fs.readdir(dir, { withFileTypes: true });
        for (const file of files) {
          const fullPath = path.join(dir, file.name);
          if (file.isDirectory()) {
            await searchDir(fullPath);
          } else if (file.name.endsWith('.md')) {
            const content = await fs.readFile(fullPath, 'utf-8');
            if (content.toLowerCase().includes(args.query.toLowerCase())) {
              results.push(path.relative(VAULT_PATH, fullPath));
            }
          }
        }
      };
      await searchDir(VAULT_PATH);
      return { content: [{ type: 'text', text: results.join('\n') || 'No results found' }] };
    }
  });

  return server;
}

// ── MCP over SSE ──────────────────────────────────────────────────────────────

const transports = {};

app.get('/sse', async (req, res) => {
  const server = createServer();
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    delete transports[transport.sessionId];
    console.log('Client disconnected');
  });

  await server.connect(transport);
  console.log('Client connected:', transport.sessionId);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send('Session not found');
  }
});

// ── Graph data API ────────────────────────────────────────────────────────────

// Maps top-level vault folder names to node types.
// Edit this to match your vault structure.
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

app.get('/graph', async (req, res) => {
  const nodes = [];
  const links = [];
  const nodeMap = {};

  const scanDir = async (dir, parentId = null) => {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      if (file.name.startsWith('.')) continue;
      const fullPath = path.join(dir, file.name);
      const relPath = path.relative(VAULT_PATH, fullPath);
      const id = relPath.replace(/\\/g, '/');
      const folder = relPath.split(path.sep)[0];
      const type = typeMap[folder] || 'memory';

      if (file.isDirectory()) {
        nodes.push({ id, label: file.name, type, r: 14 });
        nodeMap[id] = true;
        if (parentId) links.push({ source: parentId, target: id });
        await scanDir(fullPath, id);
      } else if (file.name.endsWith('.md')) {
        const content = await fs.readFile(fullPath, 'utf-8');
        const wikiLinks = [...content.matchAll(/\[\[(.+?)\]\]/g)].map(m => m[1]);
        nodes.push({ id, label: file.name.replace('.md', ''), type, r: 10 });
        nodeMap[id] = true;
        if (parentId) links.push({ source: parentId, target: id });
        for (const link of wikiLinks) {
          links.push({ source: id, target: link });
        }
      }
    }
  };

  await scanDir(VAULT_PATH);
  res.json({ nodes, links });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Memory Brain server running on port ${PORT}`);
  console.log(`Vault: ${VAULT_PATH}`);
});

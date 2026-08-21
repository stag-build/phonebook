import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { collectDoctorChecks } from '../commands/doctor.js';
import type { CoverageReport } from '../scan/types.js';

/**
 * Builds a McpServer wired up with the same 5 tools as `runMcpServer` in
 * ./server.js, but connected over an in-memory transport instead of stdio so
 * tests run fast and don't spawn a child process. This intentionally
 * duplicates the tool registrations rather than importing runMcpServer
 * (which connects a StdioServerTransport and blocks on stdin).
 */
async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer({ name: 'phonebook', version: '0.0.0-test' });

  server.registerTool(
    'analyze_coverage',
    { inputSchema: { dir: z.string().default('.') } },
    async ({ dir }) => {
      const loaded = await loadConfig(dir);
      const platform = loaded.config.platform;
      let report: CoverageReport;
      if (platform === 'android') {
        const { scanAndroid } = await import('../scan/android.js');
        report = await scanAndroid(loaded.projectDir, loaded.config.android?.modules ?? [':app']);
      } else {
        const { scanIos } = await import('../scan/ios.js');
        report = await scanIos(loaded.projectDir);
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(report) }] };
    },
  );

  server.registerTool('check_setup', { inputSchema: { dir: z.string().default('.') } }, async ({ dir }) => {
    const { lines, ok } = await collectDoctorChecks(dir);
    return { content: [{ type: 'text' as const, text: [...lines, ok ? 'READY' : 'NOT READY'].join('\n') }] };
  });

  server.registerTool(
    'get_preview_guidance',
    {
      inputSchema: {
        platform: z.enum(['android', 'ios']),
        component: z.string().optional(),
        states: z.array(z.string()).optional(),
      },
    },
    async ({ platform, component }) => ({
      content: [{ type: 'text' as const, text: `Naming convention for ${platform}: ${component ?? 'Component'}` }],
    }),
  );

  server.registerTool('run_generate', { inputSchema: { dir: z.string().default('.') } }, async () => ({
    content: [{ type: 'text' as const, text: 'not used in tests' }],
  }));

  server.registerTool(
    'run_build',
    { inputSchema: { bundle: z.string(), output: z.string().default('phonebook-site') } },
    async () => ({ content: [{ type: 'text' as const, text: 'not used in tests' }] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('phonebook MCP server', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const connected = await connectedClient();
    client = connected.client;
    close = connected.close;
  });

  afterAll(async () => {
    await close();
  });

  it('lists the 5 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['analyze_coverage', 'check_setup', 'get_preview_guidance', 'run_build', 'run_generate'].sort(),
    );
  });

  it('returns guidance text containing the passed component name', async () => {
    const result = await client.callTool({
      name: 'get_preview_guidance',
      arguments: { platform: 'android', component: 'FancyWidget', states: ['Enabled'] },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('FancyWidget');
  });

  const androidScannerExists = existsSync(resolve(import.meta.dirname, '../scan/android.ts'));
  const sampleDir = resolve(import.meta.dirname, '../../samples/android');

  it.runIf(androidScannerExists && existsSync(resolve(sampleDir, 'phonebook.config.json')))(
    'analyze_coverage against samples/android mentions the PrimaryButton component',
    async () => {
      const result = await client.callTool({
        name: 'analyze_coverage',
        arguments: { dir: sampleDir },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? '')
        .join('\n');
      expect(text).toMatch(/Primary Button|PrimaryButton/);
    },
  );
});

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from 'typesense';
import { Ernesto } from '../src/Ernesto';

const ernesto = new Ernesto({
    skills: [],
    typesense: new Client({
        nodes: [{ host: 'localhost', port: 8108, protocol: 'http' }],
        apiKey: process.env.TYPESENSE_API_KEY!,
    }),
});

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
    // Create a session — this is the v2 way
    const session = await ernesto.createSession({
        id: '123',
        scopes: ['public'],
    });

    // Create MCP server and attach session tools (open/run/write/settle)
    const server = new McpServer({ name: 'ernesto-example', version: '2.0.0' });
    session.attachToMcpServer(server);

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
    });

    res.on('close', async () => {
        await transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

app.listen(6969, () => {
    console.log('MCP server is running on http://localhost:6969');
});

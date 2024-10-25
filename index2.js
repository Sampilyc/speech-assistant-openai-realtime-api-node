// index2.js

import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
dotenv.config();

// Get the OpenAI API key from environment variables
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Falta la clave de API de OpenAI. Por favor, configúrala en el archivo .env.');
  process.exit(1);
}

// Get __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Fastify
const fastify = Fastify();

// Register CORS plugin **before** any routes or plugins
fastify.register(fastifyCors, {
  origin: 'https://logicoycreativo.com', // Replace '*' with your frontend domain
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
});

// Register other plugins
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Serve static files from 'public' folder
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/', // All routes will start with "/"
});

// Global variables
let systemMessage = 'Sos Eva, una asistente virtual amable y alegre que habla en español argentino. Te encanta conversar sobre cualquier tema que interese al usuario y estás preparada para ofrecer información. Siempre mantente positiva y ayuda al usuario en lo que necesite.';
const VOICE = 'Lucia'; // Spanish voice
const PORT = process.env.PORT || 3000; // Use process.env.PORT for Heroku compatibility

// Structure to maintain conversation context per session
let conversations = {};

// Root route
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Servidor del Avatar en Tiempo Real está en funcionamiento.' });
});

// Route to analyze image
fastify.post('/analyze-image', async (request, reply) => {
  const { image } = request.body;

  try {
    // Call OpenAI API to analyze the image
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            'role': 'user',
            'content': [
              { 'type': 'text', 'text': 'Analiza al usuario que tenés enfrente y devuélveme la descripción física, sus prendas, si es una sola persona o un grupo, si es hombre o mujer y detalles de su entorno en donde se encuentra.' },
              { 'type': 'image_url', 'image_url': { 'url': `data:image/png;base64,${image}` } }
            ]
          }
        ],
        max_tokens: 300
      })
    });

    const data = await response.json();

    if (data && data.choices && data.choices[0].message && data.choices[0].message.content) {
      const description = data.choices[0].message.content.trim();
      reply.send({ success: true, description });
    } else {
      console.error('Error en la respuesta de OpenAI:', data);
      reply.send({ success: false, message: 'No se pudo obtener una descripción' });
    }
  } catch (error) {
    console.error('Error al analizar la imagen:', error);
    reply.send({ success: false, message: 'Error al analizar la imagen' });
  }
});

// Route to update instructions
fastify.post('/update-instructions', async (request, reply) => {
  const { description, sessionId } = request.body;

  // Update the system message with the obtained description
  if (!conversations[sessionId]) {
    conversations[sessionId] = [{ role: 'system', content: systemMessage }];
  }

  // Add the description to the system message
  conversations[sessionId][0].content += ` Esta es la descripción visual del usuario y su entorno: ${description}`;

  reply.send({ success: true });
});

// Route to reset the conversation
fastify.post('/reset', async (request, reply) => {
  const { sessionId } = request.body;

  // Delete the conversation for the session
  delete conversations[sessionId];

  reply.send({ success: true });
});

// Handle OPTIONS requests for preflight
fastify.options('*', (request, reply) => {
  reply.send();
});

// WebSocket route for connections from the web avatar
fastify.register(async (fastify) => {
  fastify.get('/websocket', { websocket: true }, (connection, req) => {
    console.log('Cliente del navegador conectado');

    const sessionId = req.headers['sec-websocket-key']; // Use the WebSocket key as session identifier
    if (!conversations[sessionId]) {
      conversations[sessionId] = [{ role: 'system', content: systemMessage }];
    }

    let openAiWs;
    let isOpenAiConnected = false;

    openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2023-10-01', {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    openAiWs.on('open', () => {
      console.log('Conectado a OpenAI Realtime API');
      isOpenAiConnected = true;
      initializeSession();
    });

    function initializeSession() {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'client' },
          input_audio_format: 'webm_opus',
          output_audio_format: 'webm_opus',
          voice: VOICE,
          instructions: conversations[sessionId][0].content,
          modalities: ["text", "audio"],
          temperature: 0.8,
        }
      };

      openAiWs.send(JSON.stringify(sessionUpdate));
    }

    connection.socket.on('message', (message) => {
      if (isOpenAiConnected) {
        // Forward the received audio to OpenAI Realtime API
        openAiWs.send(message);
      }
    });

    openAiWs.on('message', (data) => {
      // Forward audio responses to the client
      connection.socket.send(data);
    });

    connection.socket.on('close', () => {
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
      console.log('Cliente del navegador desconectado');
    });

    openAiWs.on('close', () => {
      console.log('Desconectado de OpenAI Realtime API');
    });

    openAiWs.on('error', (error) => {
      console.error('Error en el WebSocket de OpenAI:', error);
    });
  });
});

// Start the server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`El servidor del Avatar está escuchando en ${address}`);
});

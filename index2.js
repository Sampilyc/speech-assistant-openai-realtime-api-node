// index2.js

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import fastifyCors from '@fastify/cors'; // Importamos el plugin de CORS

// Cargar variables de entorno desde el archivo .env
dotenv.config();

// Obtener la clave de API de OpenAI desde las variables de entorno
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Falta la clave de API de OpenAI. Por favor, configúrala en el archivo .env.');
    process.exit(1);
}

// Inicializar Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Habilitar CORS
fastify.register(fastifyCors, {
    origin: '*', // Puedes especificar el origen de tu frontend si es necesario
    methods: ['GET', 'POST', 'OPTIONS'],
});

// Servir archivos estáticos desde la carpeta 'public'
fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/', // Todas las rutas comenzarán con "/"
});

// Variables globales
let systemMessage = 'Sos Eva, una asistente virtual amable y alegre que habla en español argentino. Te encanta conversar sobre cualquier tema que interese al usuario y estás preparada para ofrecer información. Siempre mantente positiva y ayuda al usuario en lo que necesite.';
const VOICE = 'Lucia'; // Voz en español
const PORT = process.env.PORT || 3000; // Usamos process.env.PORT para compatibilidad con Heroku

// Estructura para mantener el contexto de la conversación por sesión
let conversations = {};

// Ruta raíz
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Servidor del Avatar en Tiempo Real está en funcionamiento.' });
});

// Ruta para analizar la imagen
fastify.post('/analyze-image', async (request, reply) => { // Cambiado a '/analyze-image' sin '.php'
    const { image } = request.body;

    try {
        // Llamada a la API de OpenAI para analizar la imagen
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

// Ruta para actualizar las instrucciones
fastify.post('/update-instructions', async (request, reply) => { // Cambiado a '/update-instructions' sin '.php'
    const { description, sessionId } = request.body;

    // Actualizar el mensaje del sistema con la descripción obtenida
    if (!conversations[sessionId]) {
        conversations[sessionId] = [{ role: 'system', content: systemMessage }];
    }

    // Añadir la descripción al mensaje del sistema
    conversations[sessionId][0].content += ` Esta es la descripción visual del usuario y su entorno: ${description}`;

    reply.send({ success: true });
});

// Ruta para reiniciar la conversación
fastify.post('/reset', async (request, reply) => { // Cambiado a '/reset' sin '.php'
    const { sessionId } = request.body;

    // Eliminar la conversación de la sesión
    delete conversations[sessionId];

    reply.send({ success: true });
});

// Ruta WebSocket para conexiones desde el avatar web
fastify.register(async (fastify) => {
    fastify.get('/websocket', { websocket: true }, (connection, req) => {
        console.log('Cliente del navegador conectado');

        const sessionId = req.headers['sec-websocket-key']; // Utilizamos la clave del WebSocket como identificador de sesión
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
                // Transmitir el audio recibido a OpenAI Realtime API
                openAiWs.send(message);
            }
        });

        openAiWs.on('message', (data) => {
            // Transmitir las respuestas de audio al cliente
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

// Iniciar el servidor
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`El servidor del Avatar está escuchando en el puerto ${PORT}`);
});

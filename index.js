import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = 'Sos Estefania. Atención al cliente de la empresa Molinos Rio de la plata. Sos argentina, hablas bien como un porteño, tanto en forma de hablar y acentuación. Sos simpática y servicial.';
const VOICE = 'shimmer';
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = [
    'error', 'response.content.done', 'rate_limits.updated', 'response.done',
    'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started', 'session.created'
];

const SHOW_TIMING_MATH = false;

// Ruta principal para confirmar que el servidor está en funcionamiento
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream and Web Media Stream are running!' });
});

// Ruta de Twilio para manejar llamadas entrantes
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say language="es-MX" voice="Polly.Lucia">Gracias por comunicarte con nuestro centro de atención al consumidor de Molinos.</Say>
                              <Pause length="1"/>
                              <Say language="es-MX" voice="Polly.Lucia">Ya podés empezar a hablar.</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket para el flujo de medios de Twilio
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Cliente Twilio conectado a /media-stream');

        // Aquí va la lógica específica de Twilio para el manejo de WebSocket
        let streamSid = null;

        // Manejar mensajes desde Twilio
        connection.on('message', (message) => {
            const data = JSON.parse(message);
            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log('Stream SID:', streamSid);
                    break;
                case 'media':
                    // Procesar la data de medios aquí
                    break;
                case 'stop':
                    console.log('Conexión finalizada por Twilio');
                    break;
                default:
                    console.log('Evento no manejado:', data.event);
                    break;
            }
        });

        // Cerrar la conexión
        connection.on('close', () => {
            console.log('Conexión Twilio cerrada.');
        });
    });
});

// WebSocket para el flujo de medios en la web
fastify.register(async (fastify) => {
    fastify.get('/web-media-stream', { websocket: true }, (connection, req) => {
        console.log('Cliente Web conectado a /web-media-stream');

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Mantener la conexión viva con pings regulares
        const keepAliveInterval = setInterval(() => {
            if (connection.readyState === connection.OPEN) {
                connection.ping();
                console.log('Ping enviado para mantener la conexión');
            }
        }, 30000);

        connection.on('close', () => {
            clearInterval(keepAliveInterval);
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Cliente Web desconectado.');
        });

        openAiWs.on('open', () => {
            console.log('Conectado a la API Realtime de OpenAI');
            // Enviar un mensaje de configuración de sesión inicial a OpenAI
            openAiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'webm_opus',
                    output_audio_format: 'webm_opus',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            }));
        });

        openAiWs.on('message', (data) => {
            const response = JSON.parse(data);
            if (response.type === 'response.audio.delta' && response.delta) {
                const audioDelta = {
                    event: 'media',
                    media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                };
                connection.send(JSON.stringify(audioDelta));
            }
        });

        openAiWs.on('error', (error) => {
            console.error('Error en la conexión WebSocket de OpenAI:', error);
        });

        openAiWs.on('close', () => {
            console.log('Conexión con OpenAI cerrada');
        });
    });
});

// Iniciar el servidor
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error('Error al iniciar el servidor:', err);
        process.exit(1);
    }
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});

// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Cargar variables de entorno desde el archivo .env
dotenv.config();

// Obtener la clave API de OpenAI de las variables de entorno
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Falta la clave API de OpenAI. Por favor, establécela en el archivo .env.');
    process.exit(1);
}

// Inicializar Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constantes
const SYSTEM_MESSAGE_TWILIO = 'Sos Estefania. Atención al cliente de la empresa Molinos Rio de la Plata. Sos argentina, hablas bien como un porteño, tanto en forma de hablar y acentuación. Sos simpática y servicial. Estás hablando por teléfono con el usuario que acaba de llamar.';
const SYSTEM_MESSAGE_WEB = 'Sos Estefania, la asistente virtual de Molinos Rio de la Plata. Atendés al usuario que chatea contigo desde la web.';
const VOICE = 'shimmer';
const PORT = process.env.PORT || 5050; // Permitir asignación dinámica de puertos

// Lista de tipos de eventos para registrar en la consola
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Mostrar cálculos de tiempo de respuesta de la IA
const SHOW_TIMING_MATH = false;

// Ruta raíz
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Servidor en funcionamiento' });
});

// **Funcionalidad de Twilio (sin cambios)**

// Ruta para que Twilio maneje llamadas entrantes
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

// WebSocket route for media-stream (Twilio)
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Cliente conectado a Twilio media-stream');

        // Estado específico de la conexión
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control de sesión inicial con OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE_TWILIO,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Enviando actualización de sesión:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Enviar mensaje inicial para que la IA hable primero
            sendInitialConversationItem();
        };

        // Enviar ítem de conversación inicial si la IA habla primero
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Hola!'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Enviando ítem de conversación inicial:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Manejar interrupción cuando el llamante comienza a hablar
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculando tiempo transcurrido para truncar: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Enviando evento de truncamiento:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reiniciar
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Enviar mensajes de marca a Media Streams para saber si la reproducción de la respuesta de la IA ha terminado
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Evento de apertura para el WebSocket de OpenAI
        openAiWs.on('open', () => {
            console.log('Conectado a la API Realtime de OpenAI');
            setTimeout(initializeSession, 100);
        });

        // Escuchar mensajes del WebSocket de OpenAI (y enviar a Twilio si es necesario)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Evento recibido: ${response.type}`, response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // El primer delta de una nueva respuesta inicia el contador de tiempo transcurrido
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Estableciendo timestamp de inicio para nueva respuesta: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error procesando mensaje de OpenAI:', error, 'Mensaje sin procesar:', data);
            }
        });

        // Manejar mensajes entrantes de Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Mensaje de medios recibido con timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('El stream entrante ha comenzado', streamSid);

                        // Reiniciar el inicio y el timestamp de medios en un nuevo stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Evento no de medios recibido:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error analizando mensaje:', error, 'Mensaje:', message);
            }
        });

        // Manejar cierre de conexión
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Cliente desconectado.');
        });

        // Manejar cierre y errores del WebSocket
        openAiWs.on('close', () => {
            console.log('Desconectado de la API Realtime de OpenAI');
        });

        openAiWs.on('error', (error) => {
            console.error('Error en el WebSocket de OpenAI:', error);
        });
    });
});

// **Funcionalidad Web (añadida)**

// Ruta WebSocket para la funcionalidad web
fastify.register(async (fastify) => {
    fastify.get('/web-media-stream', { websocket: true }, (connection, req) => {
        console.log('Cliente conectado al stream web');

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'pcm16',
                    output_audio_format: 'pcm16',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE_WEB,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };
            console.log('Enviando actualización de sesión para web:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        openAiWs.on('open', () => {
            console.log('Conectado a la API Realtime de OpenAI para web');
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Evento recibido para web: ${response.type}`, response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioBuffer = Buffer.from(response.delta, 'base64');

                    // Enviar datos de audio de vuelta al cliente
                    connection.socket.send(audioBuffer);
                }
            } catch (error) {
                console.error('Error procesando mensaje de OpenAI para web:', error, 'Mensaje sin procesar:', data);
            }
        });

        connection.socket.on('message', async (message) => {
            try {
                // Recibir datos de audio PCM del cliente
                if (openAiWs.readyState === WebSocket.OPEN) {
                    const audioAppend = {
                        type: 'input_audio_buffer.append',
                        audio: Buffer.from(message).toString('base64')
                    };
                    openAiWs.send(JSON.stringify(audioAppend));
                }
            } catch (error) {
                console.error('Error procesando mensaje del cliente web:', error, 'Mensaje:', message);
            }
        });

        connection.socket.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Cliente web desconectado.');
        });

        openAiWs.on('close', () => {
            console.log('Conexión con OpenAI cerrada para web');
        });

        openAiWs.on('error', (error) => {
            console.error('Error en el WebSocket de OpenAI para web:', error);
        });
    });
});

// Iniciar el servidor
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error('Error iniciando el servidor:', err);
        process.exit(1);
    }
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});

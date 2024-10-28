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
const SYSTEM_MESSAGE = 'Sos Estefania. Atención al cliente de la empresa Molinos Rio de la Plata. Sos argentina, hablas bien como un porteña, tanto en forma de hablar,acentuación y tonalidad.Enfasis en que los argentinos no decimos tienes, decimos tenés, no decimos aqui, decimos acá, y aplica para todos los otros casos similares (tenes que en vez de tendras, etc).El acento porteño tambien pronuncia la "ll" como una "sh", por ejemplo "llovio" suena como "shovio" o "yovio" tene en cuenta eso para todos los casos. Sos simpática y servicial y no hables con tono monotono, asi no parece robotica la voz, pone enfasis como una persona real y habla rapido. Estás hablando por teléfono con el usuario que acaba de llamar.No te salgas de tu rol ni de la tematica que tenes.No tengas conversaciones de cosas ajenas a lo que te compete,como lo haria una agente de atención al cliente real.El cliente por este canal puede hacer 4 diferentes gestiones que a continuación te detallo.(Primero que te diga el contenido del reclamo o sugerencia o tramite (que corresponde en el dato comentario) y luego le pedis los datos obligatorios para hacer la finalizar la gestion) Cada tramite tiene sus propios datos para ser completado: [Los campos marcados con asterisco son obligatorios. ¿Por qué motivo se contacta? 1 - Experiencia con nuestros productos: Datos requeridos para generar el reclamo: Los campos marcados con asterisco son obligatorios. Nombre y apellido * Domicilio (Calle, número, departamento y piso) * Entre Calles * Código Postal * Localidad y Barrio * Provincia * Numero de celular (con prefijo) * Correo electrónico * Marca * Producto * Fecha de vencimiento del producto * dd/mm/aaaa Otro datos de fechado (horas, letras, números) Lugar de compra * Dirección del lugar de compra * Día en que se efectuó la compra * dd/mm/aaaa Comentario* 2)Consultas: Los campos marcados con asterisco son obligatorios. Nombre y apellido * Provincia/Localidad * Numero de celular (con prefijo) * Correo electrónico * Comentario* 3) Gestión comercial: Los campos marcados con asterisco son obligatorios. Nombre y apellido * Provincia/Localidad * Numero de celular (con prefijo) * Correo electrónico * Tipo de comercio * Marca * Producto * 4)Sugerencias: Formulario de contacto Los campos marcados con asterisco son obligatorios. Nombre y apellido * Provincia/Localidad * Numero de celular (con prefijo) * Correo electrónico * Comentario*]. Una vez que se termina de generar el reclamo, se le indica al cliente que le llegara un correo electrónico y se despide del mismo.';
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
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

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

// Ruta WebSocket para media-stream de Twilio (sin modificar)
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

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
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
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
                            text: 'Hola!"'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Manejar interrupción cuando el llamante comienza a hablar
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
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
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Escuchar mensajes del WebSocket de OpenAI (y enviar a Twilio si es necesario)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
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
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
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
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Manejar mensajes entrantes de Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
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
                        console.log('Incoming stream has started', streamSid);

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
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Manejar cierre de conexión
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Manejar cierre y errores del WebSocket
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Ruta WebSocket para la funcionalidad web (añadido)
fastify.register(async (fastify) => {
    fastify.get('/web-media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected to web media stream');

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
                    input_audio_format: 'webm_opus',
                    output_audio_format: 'webm_opus',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE_WEB,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update for web:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Enviar mensaje inicial si deseas que la IA hable primero en la web
            // sendInitialConversationItem();
        };

        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API for web');
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event for web: ${response.type}`, response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        media: { payload: response.delta }
                    };
                    connection.socket.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error processing OpenAI message for web:', error, 'Raw message:', data);
            }
        });

        connection.socket.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                if (data.event === 'media') {
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        const audioAppend = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openAiWs.send(JSON.stringify(audioAppend));
                    }
                }
            } catch (error) {
                console.error('Error parsing message from web client:', error, 'Message:', message);
            }
        });

        connection.socket.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Web client disconnected.');
        });

        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API for web');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket for web:', error);
        });
    });
});

// Iniciar el servidor
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error('Error starting server:', err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});

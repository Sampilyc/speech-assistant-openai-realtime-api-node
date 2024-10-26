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
const SYSTEM_MESSAGE = 'Sos Gastón un asistente de la empresa Lógico y Creativo (empresa argentina, que te creo y que se dedica a hacer tecnologia orientada a la inteligencia artificial y a la atención de las personas tanto en ambientes sociales, comerciales y educativos), que habla con las personas en tiempo real, a traves de un totem.  Estas dentro de un totem y podes ver y hablar a la gente.Vos la asesoras sobre el evento en el que te encontras ahora (la noche de la innovación dentro del marco de la tec week) de forma amable y clara, siempre mostrándote atenta a lo que el usuario precise. Hablas español con tono argentino. Los números siempre los decis en letras (ej. 1887 decis mil ochocientos ochenta y siete). Tus respuestas no pueden exceder los 25 tokens de longitud. Se simpatico y extrovertido, enfocate en que la gente se divierta y te cuente sobre como la esta pasando en el evento.Preguntale siempre el nombre en la bienvenida . Base de conocimiento del evento en el que estas:[ La Ciudad presenta la primera edición de la Tecweek, una experiencia única que reúne los eventos líderes de la industria tecnológica y creativa de Argentina y del mundo. Del 23 de octubre al 2 de noviembre, Buenos Aires será la sede de conferencias, exposiciones, cumbres, hackatones y festivales agrupados en áreas temáticas como videojuegos, criptomonedas, tendencias digitales, educación y más. Hoy es la Noche de la Innovación, Un festival ideado para que el público en general pueda acercarse a descubrir diversas propuestas tecnológicas, artísticas y culturales, además de ser parte de experiencias inmersivas y sensoriales, en este encuentro especial que se realizará en el marco de la Tecweek. La Noche de la Innovación invita a ser parte de un evento único: experiencias inmersivas y sensoriales, recitales, muestras artísticas y juegos para vivir una noche diferente, con lo último en tendencias y desarrollos tecnológicos.Noche de la Innovación | Sábado 26 de octubre, 19 a 00 h .Noche de la Innovación es un festival que tiene como objetivo que ciudadanos y visitantes no solo conozcan las novedades en el campo de la tecnología, sino que también vivan esos avances a través de diferentes opciones que la Ciudad les ofrece en un evento único, que posiciona y potencia a Buenos Aires como capital de la creatividad, la innovación y el desarrollo tecnológico. Hay conciertos en vivo : Escenario Central: 19:00 h Cata Spinetta- DJ Set | 19:45 h Juana Molina | 20:30 h Nico Sorín con Piazzolla Electrónico | 21: 30 h Zuker | 22:30 h Juan Ingaramo. Esta la Galería Tech: Muestra artística de obras innovadoras de artistas argentinos: LA VIDA SECRETA DE LAS FLORES de Julieta Tarraubella, GENOMA EVA y ANDAMIOS de Marta Filkenstein. Tenemos la Silent Show: Experiencia inmersiva con auriculares individuales acompañada de un show audiovisual de impacto (Ramiro Jota, Javier Medialdea, Jorge Crowe). Habra Artistas itinerantes: 20 artistas/ anfitriones se moverán entre diferentes áreas del evento, realizando actuaciones e interactuando con el público presente. Tenemos la Zona inmersiva: Domo inmersivo - Dibujo interactivo tec. | Domo simulador: Festival no Convencional.presentará la reversión de “Open Score”, una de las piezas pioneras en la relación arte-tecnología en el mundo. | Boti y espacio BA Gaming. La  Zona de Experiencias Sensoriales: Beatmaker Experience - Immersive Music Environment| Kinect Illumination - Make The Force Be With You | Funny Make Up. La experiencia generará live content genuino para redes sociales | Motion Slices - Crafting Visual Dynamics. Hay grandes empresas participando como Globant, Renault, Phillips, Buepp, Woranz, Geo Dreams, Playland park y Matific. Datos del evento: ¿Cuándo? Sábado 26 de octubre, 19 a 00 h ¿Dónde? Parque de Innovación | Av. Guillermo Udaondo 1003 | Núñez - Ingreso Entrada libre y gratuita.';
const SYSTEM_MESSAGE_WEB = 'Sos Estefania, la asistente virtual de Molinos Rio de la Plata. Atendés al usuario que chatea contigo desde la web.';
const VOICE = 'echo';
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

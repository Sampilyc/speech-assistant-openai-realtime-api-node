// index2.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;

const fastify = Fastify();
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = 'Sos Estefania. Atención al cliente de la empresa Molinos Rio de la plata. Sos argentina, hablas bien como un porteño, tanto en forma de hablar y acentuación. Sos simpática y servicial.';
const VOICE = 'shimmer';
const PORT = process.env.PORT || 6060;

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Web-based Media Stream Server is running!' });
});

fastify.register(async (fastify) => {
    fastify.get('/web-media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Initialization and configuration of OpenAI session
        const initializeSession = () => {
            const sessionUpdate = {
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
            };
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
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

        connection.on('message', (message) => {
            const data = JSON.parse(message);
            if (data.event === 'media') {
                const audioAppend = {
                    type: 'input_audio_buffer.append',
                    audio: data.media.payload
                };
                openAiWs.send(JSON.stringify(audioAppend));
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
